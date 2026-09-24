const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { BASE_URL } = require('../config');

// Rolling-window channels (NFL Network, Sky Sports Golf, ...) republish a
// starts_at of "roughly now" on every poll: measured within ±90s of the feed
// `timestamp` across consecutive fetches, while real fixtures keep a fixed
// kickoff. Anything that close to the server clock is an always-on channel,
// not a fixture that happens to start this second.
const ROLLING_WINDOW_TOLERANCE_S = 90;

// The main feed (/papi/api/streams) does not carry the 24/7-streams category
// at all. Those channels live in /papi/matches/all, which uses a different
// item shape (title instead of name, date in ms instead of starts_at in s).
const MATCHES_ALL_URL = 'https://damitv.st/papi/matches/all';
const EXTRACT_URL_BASE = 'https://damitv.st/papi/extract-url/';

class DamiTvProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'DamiTV';
    this.apiUrl = 'https://damitv.st/papi/api/streams';
    this.embedStProvider = opts.embedStProvider;
    this.embedIndiaProvider = opts.embedIndiaProvider;

    this.fetchData = this.circuitBreaker.wrap(`${this.name}_fetch`, async () => {
      const res = await this.proxyFetch(this.apiUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });

    // Secondary feed for the 24/7 channels. Non-fatal: a failure here only
    // costs the 24/7 row, not the fixture schedule.
    this.fetchAllMatches = this.circuitBreaker.wrap(`${this.name}_fetchAll`, async () => {
      const res = await this.proxyFetch(MATCHES_ALL_URL, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
  }

  /**
   * The Stremio router matches /:type/:id as a single path segment, so a "/"
   * inside the match id truncates the route (observed: 54 of 97 ids 404 on
   * the unencoded /stream path). Collapse slashes to "_" for the catalog id;
   * the true id survives inside the source's embed URL, which is what
   * resolveStream actually reads.
   */
  _sanitizeId(feedId) {
    return String(feedId).replace(/\//g, '_');
  }

  /**
   * Always-on channel detection: no away team (channel branding, not a
   * fixture) AND a starts_at that tracks the feed timestamp (rolling window).
   */
  _isRollingChannel(item, feedTimestamp) {
    if (!item) return false;
    const awayName = item.teams && item.teams.away && item.teams.away.name;
    if (awayName && String(awayName).trim() !== '') return false;
    if (!item.starts_at || !feedTimestamp) return false;
    return Math.abs(item.starts_at - feedTimestamp) <= ROLLING_WINDOW_TOLERANCE_S;
  }

  /**
   * Source ids must be unique per catalog entry: MatchAggregator dedupes on
   * (id, source), and the feed's sources[].id is just a server label ("s1",
   * "sd"), so distinct servers on one event collapse into one. Combine the
   * feed item id with the label. ":" is reserved by the episode-id format.
   */
  _sourceId(feedItemId, label) {
    return `${this._sanitizeId(feedItemId)}_${String(label).replace(/[:/]/g, '_')}`;
  }

  /**
   * Within one feed item, a source whose embed url differs from the item's
   * primary embed only by an sd=1 param hits the same extract-url endpoint
   * and mints the same HD+SD pair (with separately signed tokens, so URL
   * dedup cannot collapse them) — the user sees every stream twice. Keep
   * only sources with distinct `id` query params.
   */
  _dedupeSources(rawSources, primaryEmbedUrl) {
    const seenIds = new Set();
    const out = [];
    for (const st of rawSources) {
      let embedUrl = (st && st.embed) || primaryEmbedUrl || '';
      if (!embedUrl) continue;
      if (embedUrl.startsWith('/')) embedUrl = 'https://damitv.st' + embedUrl;

      let idParam = null;
      try {
        idParam = new URL(embedUrl).searchParams.get('id');
      } catch (_) { /* unusable embed url */ }
      if (idParam === null) continue;
      if (seenIds.has(idParam)) continue;
      seenIds.add(idParam);

      out.push({
        source: 'damitv',
        id: this._sourceId(idParam, (st && (st.id || st.name)) || 'Stream'),
        name: (st && st.name) || 'Stream',
        url: embedUrl
      });
    }
    return out;
  }

  async getMatches() {
    const matches = [];
    const seenSanitizedIds = new Set();

    try {
      const data = await this.fetchData.fire();
      if (!data || !data.success || !Array.isArray(data.streams)) return [];

      const feedTimestamp = data.timestamp || 0;

      data.streams.forEach(categoryGroup => {
        const streams = categoryGroup.streams || [];

        streams.forEach(s => {
          if (!s.id || !s.name) return;

          // Every source embed url is keyed by the ?id= param; build the
          // canonical primary embed the same way the feed does.
          const primaryEmbed = `https://damitv.st/embed/?id=${encodeURIComponent(s.id)}`;
          const rawSources = (s.sources && s.sources.length ? s.sources : [{}]);
          const sources = this._dedupeSources(rawSources, primaryEmbed);
          if (sources.length === 0) return;

          if (this._isRollingChannel(s, feedTimestamp)) {
            // Always-on channel: no league prefix (the catalog matches channel
            // logos by exact title), no fake kickoff, always in the 24/7 row.
            // Same shape DaddyLive uses for its 24/7 network ingestion.
            const sanitized = this._sanitizeId(s.id);
            if (seenSanitizedIds.has(sanitized)) return;
            seenSanitizedIds.add(sanitized);

            matches.push(new MatchEntity({
              id: `dami_${sanitized}`,
              title: s.name,
              category: 'networks',
              date: '0',
              popular: '1',
              status: '',
              league: 'Live TV',
              thumbnail_url: s.poster || '',
              poster: s.poster || '',
              sources: sources
            }));
            return;
          }

          // Terminal statuses are dropped by the catalog anyway; do not
          // advertise them here.
          if (s.status && s.status !== 'live' && s.status !== 'upcoming') return;

          const dateMs = s.starts_at ? s.starts_at * 1000 : Date.now();
          const now = Date.now();
          // Trust the feed's own status word; the clock only decides the
          // live-window fallback when the feed is silent.
          const isLive = s.status === 'live' || (!s.status && dateMs <= now && dateMs > now - (12 * 60 * 60 * 1000));
          const isUpcoming = s.status === 'upcoming' || (!s.status && dateMs > now);
          const popular = (isLive || (s.viewers || 0) > 1000) ? '1' : '0';

          let title = s.name;
          if (s.league) title = `${s.league} - ${title}`;

          const sanitized = this._sanitizeId(s.id);
          if (seenSanitizedIds.has(sanitized)) {
            console.warn(`[${this.name}] id collision after sanitization: ${s.id} -> ${sanitized}, skipping duplicate`);
            return;
          }
          seenSanitizedIds.add(sanitized);

          matches.push(new MatchEntity({
            id: `dami_${sanitized}`,
            title: title,
            category: this.normalizeCategory(categoryGroup.category || 'other'),
            date: dateMs.toString(),
            status: isLive ? 'live' : (isUpcoming ? 'upcoming' : ''),
            popular: popular,
            sources: sources,
            thumbnail_url: s.poster || '',
            poster: s.poster || '',
            team1: s.teams && s.teams.home && s.teams.home.name ? { name: s.teams.home.name, logo: s.teams.home.badge || null } : null,
            team2: s.teams && s.teams.away && s.teams.away.name ? { name: s.teams.away.name, logo: s.teams.away.badge || null } : null
          }));
        });
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }

    // The 24/7 channels live only in /papi/matches/all. Ingest the ones the
    // main feed did not already carry.
    try {
      const all = await this.fetchAllMatches.fire();
      if (Array.isArray(all)) {
        for (const item of all) {
          if (!item || !item.id || !item.title) continue;
          const cat = String(item.category || '');
          if (cat !== '24/7-streams' && !/^247-/.test(String(item.id))) continue;
          if (seenSanitizedIds.has(this._sanitizeId(item.id))) continue;

          const embedUrl = `https://damitv.st/embed/?id=${encodeURIComponent(item.id)}`;
          const sources = [{
            source: 'damitv',
            id: this._sourceId(item.id, 'ppv'),
            name: 'Server 1',
            url: embedUrl
          }];

          // substreams are sibling channels (e.g. Willow 2), each a distinct id.
          if (Array.isArray(item.substreams)) {
            for (const sub of item.substreams) {
              if (!sub || !sub.id) continue;
              const subEmbed = sub.iframe || `https://damitv.st/embed/?id=${encodeURIComponent(sub.id)}`;
              sources.push({
                source: 'damitv',
                id: this._sourceId(sub.id, sub.name || 'sub'),
                name: sub.name || 'Server 2',
                url: subEmbed
              });
            }
          }

          seenSanitizedIds.add(this._sanitizeId(item.id));
          matches.push(new MatchEntity({
            id: `dami_${this._sanitizeId(item.id)}`,
            title: item.title,
            category: 'networks',
            date: '0',
            popular: '1',
            status: '',
            league: 'Live TV',
            thumbnail_url: item.poster || '',
            poster: item.poster || '',
            logo: (item.teams && item.teams.home && item.teams.home.badge) || '',
            sources: sources
          }));
        }
      }
    } catch (error) {
      console.warn(`[${this.name}] 24/7 channel fetch failed (non-fatal):`, error.message);
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    let embedUrl = src.url || src.embedUrl || sourceId;
    if (!embedUrl || !embedUrl.startsWith('http')) return streams;

    try {
      const urlObj = new URL(embedUrl);
      const matchId = urlObj.searchParams.get('id');

      if (!matchId) return streams;

      let extractData = null;
      try {
        const extractRes = await this.proxyFetch(`${EXTRACT_URL_BASE}${encodeURIComponent(matchId)}`, {
          headers: {
            'Referer': embedUrl
          },
          signal: AbortSignal.timeout(8000)
        });

        if (extractRes.ok) {
          extractData = await extractRes.json();
        }
      } catch (extractErr) {
        console.warn(`[${this.name}] API extraction failed for ${matchId}, falling back to embed chain...`);
      }

      const referer = 'https://damitv.st/';
      const origin = 'https://damitv.st';
      const proxy = (upstream) => `${BASE_URL}/api/manifest?url=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

      if (extractData && extractData.success) {
        if (extractData.hlsUrl) {
          streams.push(new StreamEntity({
            name: this.name,
            title: matchTitle,
            url: proxy(extractData.hlsUrl),
            behaviorHints: { notWebReady: true },
            resolution: 'HD'
          }));
        }
        if (extractData.sdUrl) {
          streams.push(new StreamEntity({
            name: this.name,
            title: matchTitle,
            url: proxy(extractData.sdUrl),
            behaviorHints: { notWebReady: true },
            resolution: 'SD'
          }));
        }
      }

      // Check manual sources if API failed or returned "no sources"
      if (streams.length === 0) {
        try {
          const msRes = await this.proxyFetch('https://damitv.st/data/manual-sources.json?t=' + Date.now(), {
             timeoutMs: 5000
          });
          if (msRes.ok) {
             const msData = await msRes.json();
             if (msData && msData[matchId]) {
                for (const st of msData[matchId]) {
                   if (st.url && st.url.includes('.m3u8')) {
                      streams.push(new StreamEntity({
                        name: this.name,
                        title: matchTitle,
                        url: proxy(st.url),
                        behaviorHints: { notWebReady: true },
                        resolution: 'HD'
                      }));
                   }
                }
             }
          }
        } catch (e) {
          console.warn(`[${this.name}] Manual sources fetch failed:`, e.message);
        }
      }
      
      // Absolute fallback to web player

      if (streams.length === 0) {
        streams.push(new StreamEntity({
          name: this.name,
          title: matchTitle,
          externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
        }));
      }

    } catch (err) {
      console.warn(`[${this.name}] resolveStream error for ${embedUrl}:`, err.message);
    }

    return streams;
  }
}

module.exports = DamiTvProvider;
