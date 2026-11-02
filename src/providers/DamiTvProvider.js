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
const CHANNEL_ORIGIN = 'https://damitv.st';

// Live fixtures never use the /embed/?id= wrapper: every source on them is a
// channel feed, https://damitv.st/player/jw/?url=%2Fc%2F379.m3u8&name=...
// That page is a plain two-request flow (mint a token, then GET the channel
// playlist), so those sources are directly resolvable and must not be thrown
// away for lacking an ?id= to call /papi/extract-url with.
const HLS_TOKEN_URL = 'https://damitv.st/papi/hls-token';

// One token authorises every /c/ channel for ~12h, so a single mint serves a
// whole sync. Refresh this far ahead of expiry instead of mid-playback.
const TOKEN_SAFETY_WINDOW_S = 300;

const UA_CHROME131 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DAMITV_REFERER = 'https://damitv.st/';
const DAMITV_ORIGIN = 'https://damitv.st';

/** Route an upstream playlist through this addon's manifest proxy. */
function damitvProxyUrl(upstream) {
  return `${BASE_URL}/api/manifest?url=${encodeURIComponent(upstream)}&referer=${encodeURIComponent(DAMITV_REFERER)}&origin=${encodeURIComponent(DAMITV_ORIGIN)}&ua=${encodeURIComponent(UA_CHROME131)}`;
}

const DAMITV_PROXY_HEADERS = {
  request: {
    'Referer': DAMITV_REFERER,
    'Origin': DAMITV_ORIGIN,
    'User-Agent': UA_CHROME131
  }
};

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
    });

    // Secondary feed for the 24/7 channels. Non-fatal: a failure here only
    // costs the 24/7 row, not the fixture schedule.
    this.fetchAllMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchAll`, async () => {
      const res = await this.proxyFetch(MATCHES_ALL_URL, { headers: DAMITV_HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });

    // Cached hls token ({ tk, e }) shared by every channel resolve.
    this._hlsToken = null;
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
   * Channel feeds are the only embed shape that becomes a playlist without any
   * HTML parsing, and recognising them is what stops live fixtures from being
   * dropped. Accepted forms:
   *
   *   https://damitv.st/player/jw/?url=%2Fc%2F379.m3u8&name=ESPN%201%20NL
   *   https://damitv.st/player/hls/?url=%2Fc%2F379.m3u8
   *   https://damitv.st/c/379.m3u8
   *   enc:<base64 of a reversed absolute url>   (one channel publishes this)
   */
  _channelFromEmbed(embedUrl) {
    if (!embedUrl || typeof embedUrl !== 'string') return null;

    let target = null;
    try {
      const url = new URL(embedUrl);
      target = url.searchParams.get('url') || (url.pathname.endsWith('.m3u8') ? url.pathname : null);
    } catch (_) {
      return null;
    }
    if (!target) return null;

    // enc: values are the absolute url reversed, then base64ed.
    if (target.startsWith('enc:')) {
      try {
        const decoded = Buffer.from(target.slice(4), 'base64').toString('utf8');
        const absolute = decoded.split('').reverse().join('');
        if (!/^https?:\/\//i.test(absolute)) return null;
        target = absolute;
      } catch (_) {
        return null;
      }
    }

    // enc: channels can live on a third-party host, so keep the origin.
    let origin = CHANNEL_ORIGIN;
    if (/^https?:\/\//i.test(target)) {
      try {
        const absolute = new URL(target);
        origin = absolute.origin;
        target = absolute.pathname;
      } catch (_) {
        return null;
      }
    }

    if (!target.startsWith('/')) return null;

    const num = (target.match(/\/(\d+)\.m3u8$/) || [])[1];
    return { path: target, key: num ? `c${num}` : target.replace(/[^a-z0-9]/gi, '_'), origin };
  }

  /**
   * Two embed shapes carry a real stream and both must survive dedupe:
   *
   *   /embed/?id=<matchId>          the match wrapper page
   *   /player/jw/?url=/c/<n>.m3u8   a channel feed (every live fixture)
   *
   * The wrapper form mints the same HD+SD pair for every source whose embed
   * differs only by an sd=1 param, so those dedupe on ?id=. Channel feeds
   * dedupe on their channel path. A source with neither is unusable.
   */
  _dedupeSources(rawSources, primaryEmbedUrl) {
    const seen = new Set();
    const out = [];
    for (const st of rawSources) {
      let embedUrl = (st && st.embed) || primaryEmbedUrl || '';
      if (!embedUrl) continue;
      if (embedUrl.startsWith('/')) embedUrl = 'https://damitv.st' + embedUrl;

      const label = (st && (st.id || st.name)) || 'Stream';
      const channel = this._channelFromEmbed(embedUrl);
      let key;
      let sourceId;

      if (channel) {
        key = `ch:${channel.path}`;
        sourceId = this._sourceId(channel.key, label);
      } else {
        let idParam = null;
        try {
          idParam = new URL(embedUrl).searchParams.get('id');
        } catch (_) { /* unusable embed url */ }
        if (idParam === null) continue;
        key = `id:${idParam}`;
        sourceId = this._sourceId(idParam, label);
      }

      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        source: 'damitv',
        id: sourceId,
        name: (st && st.name) || 'Stream',
        url: embedUrl,
        // null on wrapper sources; lets resolveStream skip re-parsing.
        channelPath: channel ? channel.path : null
      });
    }
    return out;
  }

  /**
   * Mint (or reuse) the playlist token. GET /papi/hls-token answers {tk, e}
   * and the same token authorises every /c/ channel. It is refused without a
   * damitv Referer, so DAMITV_HEADERS has to travel with the request.
   */
  async _getToken(force = false) {
    const now = Math.floor(Date.now() / 1000);
    if (!force && this._hlsToken && this._hlsToken.e - now > TOKEN_SAFETY_WINDOW_S) {
      return this._hlsToken;
    }

    try {
      const res = await this.proxyFetch(HLS_TOKEN_URL, {
        headers: { ...DAMITV_HEADERS, 'Origin': DAMITV_ORIGIN, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.tk && data.e) {
          this._hlsToken = { tk: data.tk, e: data.e };
          return this._hlsToken;
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] hls token mint failed:`, err.message);
    }
    return this._hlsToken || null;
  }

  /**
   * Channel path -> playable stream. These playlists carry tiktokcdn .image
   * segments (PNG-wrapped MPEG-TS); the manifest proxy's rewrite layer already
   * de-disguises them, and streams.js tags the stream as TikTok from the
   * playlist body, so no extra handling is needed here.
   */
  async _resolveChannel(channel, matchTitle) {
    const token = await this._getToken();
    if (!token) return null;

    const sep = channel.path.includes('?') ? '&' : '?';
    const upstream = `${channel.origin || CHANNEL_ORIGIN}${channel.path}${sep}tk=${encodeURIComponent(token.tk)}&e=${token.e}`;

    const stream = new StreamEntity({
      name: this.name,
      title: matchTitle,
      url: damitvProxyUrl(upstream),
      behaviorHints: { notWebReady: true, proxyHeaders: DAMITV_PROXY_HEADERS },
      resolution: 'HD'
    });
    stream.isTikTok = true;
    stream._isTikTok = true;
    return stream;
  }

  /**
   * Opt-out gate. DamiTV's /c/ channels are TikTok restreams: each segment is a
   * zlib-compressed PNG container, so serving them means inflating and relaying
   * every segment through this host. That bandwidth is not wanted here, so the
   * provider can be switched off with DAMITV_ENABLED=false. Enabled everywhere
   * else by default, so an unset env changes nothing.
   */
  isEnabled() {
    return process.env.DAMITV_ENABLED !== 'false';
  }

  async getMatches() {
    if (!this.isEnabled()) return [];
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

          // Fallback embed for items whose sources carry no embed of their
          // own: the match wrapper page, built the way the feed builds it.
          const primaryEmbed = `https://damitv.st/embed/?id=${encodeURIComponent(s.id)}`;
          const rawSources = (s.sources && s.sources.length ? s.sources : [{}]);
          let sources = this._dedupeSources(rawSources, primaryEmbed);
          // When real channel feeds exist the wrapper page adds nothing: it
          // only republishes the same content behind an unreadable embed.
          const channelSources = sources.filter(src => src.channelPath);
          if (channelSources.length) sources = channelSources;
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
    if (!this.isEnabled()) return streams;

    const embedUrl = src.url || src.embedUrl || '';
    if (!embedUrl || !embedUrl.startsWith('http')) return streams;

    // Channel feeds resolve with no HTML at all: mint a token, GET the playlist.
    const channel = this._channelFromEmbed(embedUrl);
    if (channel) {
      const stream = await this._resolveChannel(channel, matchTitle);
      if (stream) streams.push(stream);
    }

    let matchId = null;
    try {
      matchId = new URL(embedUrl).searchParams.get('id');
    } catch (_) { /* unusable embed url */ }

    // Nothing to play: neither a channel path nor a match id. Emitting the
    // web-player fallback here would advertise a stream that cannot exist.
    if (!channel && !matchId) return streams;

    // Wrapper pages still go through /papi/extract-url when it has something
    // to say. It currently answers {"success":false,"error":"no sources"} for
    // every id, so this is opportunistic and must not gate the channel path.
    if (streams.length === 0 && matchId) {
      try {
        const extractRes = await this.proxyFetch(`${EXTRACT_URL_BASE}${encodeURIComponent(matchId)}`, {
          headers: {
            'User-Agent': UA_CHROME131,
            'Referer': embedUrl
          },
          signal: AbortSignal.timeout(8000)
        });

        if (extractRes.ok) {
          const extractData = await extractRes.json();
          if (extractData && extractData.success) {
            for (const [field, resolution] of [['hlsUrl', 'HD'], ['sdUrl', 'SD']]) {
              const upstream = extractData[field];
              if (!upstream) continue;
              const s = new StreamEntity({
                name: this.name,
                title: matchTitle,
                url: damitvProxyUrl(upstream),
                behaviorHints: { notWebReady: true, proxyHeaders: DAMITV_PROXY_HEADERS },
                resolution
              });
              if (/streamed\/admin|strmd\.st|\.image|tiktokcdn|byteoversea/i.test(upstream)) {
                s.isTikTok = true;
                s._isTikTok = true;
              }
              streams.push(s);
            }
          }
        }
      } catch (err) {
        console.warn(`[${this.name}] API extraction failed for ${matchId}, falling back to embed chain...`);
      }
    }

    // Absolute fallback: hand the player the site's own embed page. /data/
    // manual-sources.json used to sit here, but it 404s upstream now.
    if (streams.length === 0) {
      streams.push(new StreamEntity({
        name: this.name,
        title: matchTitle,
        externalUrl: `/watch?url=${encodeURIComponent(embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
      }));
    }

    return streams;
  }
}

module.exports = DamiTvProvider;
