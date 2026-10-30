const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');
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
// Local pool saturation says nothing about provider health. Do not let it
// count as a DamiTV failure or prevent a later sync from trying again.
const localCapacityFilter = error => error?.code === 'ERR_OUTBOUND_CAPACITY';

const DAMITV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Referer': 'https://damitv.st/'
};

class DamiTvProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'DamiTV';
    this.apiUrl = 'https://damitv.st/papi/api/streams';
    this.embedStProvider = opts.embedStProvider;
    this.embedIndiaProvider = opts.embedIndiaProvider;

    this.fetchData = this.circuitBreaker.wrapSync(`${this.name}_fetch`, async () => {
      const res = await this.proxyFetch(this.apiUrl, { headers: DAMITV_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }, { errorFilter: localCapacityFilter });

    // Secondary feed for the 24/7 channels. Non-fatal: a failure here only
    // costs the 24/7 row, not the fixture schedule.
    this.fetchAllMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchAll`, async () => {
      const res = await this.proxyFetch(MATCHES_ALL_URL, { headers: DAMITV_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }, { errorFilter: localCapacityFilter });
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
      if (!data || !data.success || !Array.isArray(data.streams)) throw new Error('Invalid primary feed');

      const feedTimestamp = data.timestamp || 0;

      data.streams.forEach(categoryGroup => {
        if (!categoryGroup || !Array.isArray(categoryGroup.streams)) return;
        const streams = categoryGroup.streams;

        streams.forEach(s => {
          if (!s || !s.id || !s.name) return;

          // Every source embed url is keyed by the ?id= param; build the
          // canonical primary embed the same way the feed does.
          const primaryEmbed = `https://damitv.st/embed/?id=${encodeURIComponent(s.id)}`;
          const rawSources = (Array.isArray(s.sources) && s.sources.length ? s.sources : [{}]);
          const sources = this._dedupeSources(rawSources, primaryEmbed);
          if (sources.length === 0) return;

          if (this._isRollingChannel(s, feedTimestamp)) {
            // Always-on channel: no league prefix (the catalog matches channel
            // logos by exact title), no fake kickoff, always in the 24/7 row.
            // Same shape DaddyLive uses for its 24/7 network ingestion.
            const sanitized = this._sanitizeId(s.id);
            if (seenSanitizedIds.has(sanitized)) return;
            seenSanitizedIds.add(sanitized);

            const ident = ChannelIdentityService.parseChannel(s.name, { group: s.league });
            const canonicalTitle = ident.canonicalTitle;
            const enrichedSources = sources.map(src => ({
              ...src,
              channelName: s.name,
              canonicalChannel: canonicalTitle,
              country: ident.country || '',
              countryCode: ident.countryCode || '',
              countryFlag: ident.countryFlag || '',
              language: ident.language || '',
              resolution: ident.resolution || '',
              isBackup: ident.isBackup || false,
              isTimeshift: ident.isTimeshift || false,
              type: 'channel'
            }));

            const entity = new MatchEntity({
              id: `dami_${sanitized}`,
              title: canonicalTitle,
              baseTitle: canonicalTitle,
              category: 'networks',
              date: '0',
              popular: '1',
              status: '',
              league: 'Live TV',
              thumbnail_url: s.poster ? (s.poster.startsWith('//') ? 'https:' + s.poster : s.poster) : '',
              poster: s.poster ? (s.poster.startsWith('//') ? 'https:' + s.poster : s.poster) : '',
              sources: enrichedSources
            });
            entity.channelIdentityKey = ident.identityKey;
            entity.channelNumber = ident.channelNumber;
            entity.canonicalTitle = canonicalTitle;
            matches.push(entity);
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
            league: s.league || '',
            thumbnail_url: s.poster && !s.poster.includes('ppvservices.st') ? (s.poster.startsWith('//') ? 'https:' + s.poster : s.poster) : '',
            poster: s.poster && !s.poster.includes('ppvservices.st') ? (s.poster.startsWith('//') ? 'https:' + s.poster : s.poster) : '',
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
          const ident = ChannelIdentityService.parseChannel(item.title);
          const canonicalTitle = ident.canonicalTitle;
          const enrichedSources = sources.map(src => ({
            ...src,
            channelName: item.title,
            canonicalChannel: canonicalTitle,
            country: ident.country || '',
            countryCode: ident.countryCode || '',
            countryFlag: ident.countryFlag || '',
            language: ident.language || '',
            resolution: ident.resolution || '',
            isBackup: ident.isBackup || false,
            isTimeshift: ident.isTimeshift || false,
            type: 'channel'
          }));

          const entity = new MatchEntity({
            id: `dami_${this._sanitizeId(item.id)}`,
            title: item.title,
            baseTitle: item.title,
            category: 'networks',
            date: '',
            popular: '1',
            status: '',
            league: 'Live TV',
            thumbnail_url: '',
            poster: '',
            logo: '',
            sources: enrichedSources
          });
          entity.channelIdentityKey = ident.identityKey;
          entity.channelNumber = ident.channelNumber;
          entity.canonicalTitle = canonicalTitle;
          matches.push(entity);
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
    if (!embedUrl || !embedUrl.startsWith('http')) { console.info('[DamiTV] Extraction skipped', JSON.stringify({ reason: 'missing_embed_url' })); return streams; }

    try {
      const urlObj = new URL(embedUrl);
      const matchId = urlObj.searchParams.get('id');

      if (!matchId) { console.info('[DamiTV] Extraction skipped', JSON.stringify({ reason: 'missing_match_id' })); return streams; }

      console.info('[DamiTV] Extraction started');

      let extractData = null;
      let extractPhase = 'fetch';
      try {
        const extractRes = await this.proxyFetch(`${EXTRACT_URL_BASE}${encodeURIComponent(matchId)}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': embedUrl
          },
          timeoutMs: 11000,
          signal: AbortSignal.timeout(11000)
        });

        if (extractRes.ok) {
          extractPhase = 'parse';
          extractData = await extractRes.json();
        } else {
          console.warn(`[${this.name}] API extraction returned a non-success response`, JSON.stringify({ status: extractRes.status }));
        }
      } catch (extractErr) {
        const kind = ['SyntaxError', 'TimeoutError', 'AbortError', 'TypeError'].includes(extractErr?.name) ? extractErr.name : 'Error';
        const code = typeof extractErr?.code === 'string' && /^(ERR_[A-Z0-9_]{1,64}|ETIMEDOUT|ECONNRESET|ABORT_ERR)$/.test(extractErr.code) ? extractErr.code : undefined;
        console.warn(`[${this.name}] API extraction failed`, JSON.stringify({ phase: extractPhase, kind, ...(code ? { code } : {}) }));
      }

      const UA_CHROME131 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      const referer = 'https://damitv.st/';
      const origin = 'https://damitv.st';
      const proxy = (upstream) => `${BASE_URL}/api/manifest?url=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}&ua=${encodeURIComponent(UA_CHROME131)}`;
      const proxyHeaders = {
        request: {
          'Referer': referer,
          'Origin': origin,
          'User-Agent': UA_CHROME131
        }
      };

      if (extractData && extractData.success) {
        console.info('[DamiTV] Extraction response', JSON.stringify({ success: true, hasHls: !!extractData.hlsUrl, hasSd: !!extractData.sdUrl }));
        if (extractData.hlsUrl) {
          const isTikTokStream = Boolean(/streamed\/admin|strmd\.st|\.image|tiktokcdn|byteoversea/i.test(extractData.hlsUrl));
          const s = new StreamEntity({
            name: this.name,
            title: matchTitle,
            url: proxy(extractData.hlsUrl),
            behaviorHints: { notWebReady: true, proxyHeaders },
            resolution: 'HD'
          });
          if (isTikTokStream) {
            s.isTikTok = true;
            s._isTikTok = true;
          }
          streams.push(s);
        }
        if (extractData.sdUrl) {
          const isTikTokStream = Boolean(/streamed\/admin|strmd\.st|\.image|tiktokcdn|byteoversea/i.test(extractData.sdUrl));
          const s = new StreamEntity({
            name: this.name,
            title: matchTitle,
            url: proxy(extractData.sdUrl),
            behaviorHints: { notWebReady: true, proxyHeaders },
            resolution: 'SD'
          });
          if (isTikTokStream) {
            s.isTikTok = true;
            s._isTikTok = true;
          }
          streams.push(s);
        }
      }

      // Check manual sources if API failed or returned "no sources"
      if (streams.length === 0) {
        try {
          const msRes = await this.proxyFetch('https://damitv.st/data/manual-sources.json?t=' + Date.now(), {
            headers: {
              'User-Agent': UA_CHROME131,
              'Referer': 'https://damitv.st/'
            },
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
                        behaviorHints: { notWebReady: true, proxyHeaders },
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
