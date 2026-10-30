'use strict';
const { fetchUndici: fetch } = require('../../services/ProviderOutbound');

const SkTechCrypto = require('./SkTechCrypto');
const SkTechEmbedExtractor = require('./SkTechEmbedExtractor');
const { BASE_URL } = require('../../config');

const BASE_API_URL = 'https://dk01-64n.pages.dev/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DYNAMIC_EVENT_FEEDS = [
  { label: 'FanCode', url: 'https://raw.githubusercontent.com/doctor-8trange/zyphx8/refs/heads/main/data/fancode.m3u' },
  { label: 'FanCode', url: 'https://jabra-fan2.saqlainhaider8198.workers.dev/playlist.m3u' },
  { label: 'Sony LIV', url: 'https://nonyliv.saqlainhaider8198.workers.dev/nony2.m3u' }
];

class SkTechMatchResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_API_URL;
    this._dynamicCache = null;
    this._dynamicCacheTime = 0;
    this._eventStreamCache = new Map();
  }

  /**
   * Helper to normalize category names into canonical Nuvio sport categories
   */
  normalizeCategory(cat, title = '') {
    const combined = `${cat || ''} ${title || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (combined.includes('soccer') || combined.includes('football') || combined.includes('laliga') || combined.includes('seriea') || combined.includes('bundesliga') || combined.includes('premierleague') || combined.includes('uefa')) return 'football';
    if (combined.includes('cricket') || combined.includes('ipl') || combined.includes('t20') || combined.includes('odi') || combined.includes('namibia') || combined.includes('uganda') || combined.includes('champions')) return 'cricket';
    if (combined.includes('basketball') || combined.includes('nba')) return 'basketball';
    if (combined.includes('boxing') || combined.includes('wwe') || combined.includes('aew') || combined.includes('ufc') || combined.includes('fight') || combined.includes('mma') || combined.includes('tna')) return 'mma';
    if (combined.includes('motogp') || combined.includes('formula1') || combined.includes('f1') || combined.includes('racing') || combined.includes('rally') || combined.includes('cycling')) return 'motorsport';
    if (combined.includes('tennis') || combined.includes('atp') || combined.includes('wta')) return 'tennis';
    if (combined.includes('baseball') || combined.includes('mlb')) return 'baseball';
    if (combined.includes('hockey') || combined.includes('nhl')) return 'hockey';
    return 'other';
  }

  /**
   * Cleans raw M3U titles by stripping language tags, quality markers, emojis, and brackets
   */
  cleanEventTitle(rawTitle, tvgName = '') {
    let title = (tvgName && /\bvs\b/i.test(tvgName)) ? tvgName : (rawTitle || tvgName || '');
    // Strip language/commentary prefixes: e.g. "ENG |", "HIN |", "[HINDI]", "Tamil |"
    title = title.replace(/^[A-Za-z]{2,8}\s*\|\s*/i, '');
    title = title.replace(/^\[[A-Za-z\s]+\]\s*/i, '');
    // Strip emojis
    title = title.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u, '');
    title = title.replace(/^\[[^\]]+\]\s*/, '');
    // Strip resolution and quality tags: e.g. "1080p", "720p", "(HD)", "[FHD]", "4K"
    title = title.replace(/\s*([\[(]?(?:4K|UHD|FHD|HD|1080p?|720p?|540p?|480p?|360p?|240p?|144p?)[\])]?)\s*$/i, '');
    // Strip date/match-day suffixes
    title = title.replace(/\s*-\s*(?:MD\s*\d+\s*-\s*)?\d{1,2}\s+[A-Za-z]+\s+\d{4}.*$/i, '');
    title = title.replace(/\s*\[LIVE\].*$/i, '');
    // Strip trailing language tags: e.g. "| Hindi", "(English)", "- Hindi"
    title = title.replace(/\s*[|\-(]\s*(?:Español|Spanish|English|Hindi|Bengali|Tamil|Telugu|Marathi|Kannada|Malayalam|Arabic)[^)]*\)?\s*$/i, '');
    title = title.replace(/\s+\d+\s*\([^)]+\)$/, '');
    title = title.replace(/\s+Vs\s+/i, ' vs ').trim();
    return title;
  }

  /**
   * Retrieves cached direct event stream metadata by source ID
   */
  getEventStream(sourceId) {
    return this._eventStreamCache.get(sourceId) || null;
  }

  /**
   * Parses SK Tech date ("DD/MM/YYYY") and time ("HH:MM:SS") into an epoch millisecond timestamp
   */
  parseKickoff(dateStr, timeStr) {
    try {
      if (!dateStr) return 0;
      const [d, m, y] = dateStr.split('/').map(Number);
      const timeParts = (timeStr || '00:00:00').split(':').map(Number);
      const hour = timeParts[0] || 0;
      const min = timeParts[1] || 0;
      const sec = timeParts[2] || 0;
      return Date.UTC(y, m - 1, d, hour, min, sec);
    } catch (_) {
      return 0;
    }
  }

  /**
   * Ingest and decrypt all live sports events from `events.txt`
   * @returns {Promise<Array<Object>>} Normalized live fixtures
   */
  async fetchEventsTxtMatches() {
    const url = `${this.baseUrl}events.txt`;
    const res = await fetch(url, {
      headers: { 'User-Agent': DEFAULT_UA }
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch events.txt: HTTP ${res.status}`);
    }

    const rawCiphertext = (await res.text()).trim();
    const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
    const rawEvents = JSON.parse(decryptedJson);

    const matches = [];

    for (let i = 0; i < rawEvents.length; i++) {
      const entry = rawEvents[i];
      const item = typeof entry.event === 'string' ? JSON.parse(entry.event) : entry.event;
      if (!item) continue;

      const teamA = (item.teamAName || '').trim();
      const teamB = (item.teamBName || '').trim();
      const eventName = (item.eventName || '').trim();

      const title = (teamA && teamB)
        ? `${teamA} vs ${teamB}`
        : (eventName || teamA || 'Live Sports Event');

      const category = this.normalizeCategory(item.category);
      const kickoff = this.parseKickoff(item.date, item.time);
      const endDate = this.parseKickoff(item.end_date, item.end_time);
      const linkPath = item.links || '';

      if (!linkPath) continue;
      const isStaleGlitch = /namibia\s*(?:vs?\.?|@|-)\s*uganda/i.test(title);
      const isTestOrDemo = isStaleGlitch ||
                           /^test\b|^demo\b|^placeholder\b|^sample\b/i.test(title) ||
                           /test_pic|streamtest|livetest|\/test\.m3u8/i.test(linkPath) ||
                           (title === 'Live Sports Event' && !linkPath);
      if (isTestOrDemo) continue;

      const now = Date.now();
      const isFinished = endDate > 0
        ? (now > endDate + 30 * 60 * 1000)
        : (kickoff > 0 ? (now > kickoff + 4 * 60 * 60 * 1000) : false);
      if (isFinished) continue;

      matches.push({
        id: `sktech_match_${i}_${Buffer.from(linkPath).toString('base64url').slice(0, 16)}`,
        title,
        category,
        kickoff,
        endDate,
        rawCategory: item.category,
        linkPath,
        linkNames: item.link_names || [],
        teamA: { name: teamA, logo: item.teamAFlag || '' },
        teamB: { name: teamB, logo: item.teamBFlag || '' },
        poster: item.eventLogo || item.teamAFlag || ''
      });
    }

    return matches;
  }

  /**
   * Public M3U content parser — extracts and deduplicates per-resolution match entries.
   * Used by fetchDynamicM3uMatches (fetches remote M3U then calls this) and directly
   * by unit tests to exercise the quality-dedup logic without network I/O.
   *
   * @param {string}  m3uText  - Raw M3U playlist text (EXTM3U format)
   * @param {Object}  feed     - Feed descriptor: { label: string, url: string }
   * @param {Map}     matchMap - Dedup index keyed by `cat:cleanTitle`
   * @param {Array}   matches  - Output array accumulating match objects
   */
  parseM3UContent(m3uText, feed, matchMap, matches) {
    const lines = m3uText.split(/\r?\n/);
    let curMeta = null;
    let curOpts = {};

    const RES_WEIGHT = {
      '1080P': 1080, '720P': 720, '540P': 540,
      '480P': 480, '360P': 360, '240P': 240, '144P': 144, 'HD': 720
    };
    const feedKey = feed.label.toLowerCase().replace(/[^a-z0-9]/g, '');

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        curMeta = { tvgId: '', tvgName: '', logo: '', lang: '', group: '', rawTitle: '' };
        curOpts = {};
        const commaIdx = line.indexOf(',');
        if (commaIdx !== -1) {
          curMeta.rawTitle = line.slice(commaIdx + 1).trim();
        }
        const metaPortion = commaIdx !== -1 ? line.slice(0, commaIdx) : line;
        const attrRe = /\b(tvg-id|tvg-name|tvg-logo|tvg-language|group-title)="([^"]*)"/gi;
        let match;
        while ((match = attrRe.exec(metaPortion)) !== null) {
          const key = match[1].toLowerCase();
          const val = match[2];
          if (key === 'tvg-id') curMeta.tvgId = val;
          else if (key === 'tvg-name') curMeta.tvgName = val;
          else if (key === 'tvg-logo') curMeta.logo = val;
          else if (key === 'tvg-language') curMeta.lang = val;
          else if (key === 'group-title') curMeta.group = val;
        }
      } else if (line.startsWith('#EXTVLCOPT:')) {
        const opt = line.slice(11).trim();
        const separator = opt.indexOf('=');
        const k = separator < 0 ? '' : opt.slice(0, separator);
        const v = separator < 0 ? '' : opt.slice(separator + 1);
        if (k && v) {
          if (/referrer/i.test(k))    curOpts['Referer']    = v;
          if (/user-agent/i.test(k))  curOpts['User-Agent'] = v;
        }
      } else if (line.startsWith('http') && curMeta) {
        const parsed = SkTechEmbedExtractor.parseDelimited(line, { defaultUserAgent: false });
        if (parsed.url) {
          const clean   = this.cleanEventTitle(curMeta.rawTitle, curMeta.tvgName);
          const isTestOrDemo = /^test\b|^demo\b|^placeholder\b|^sample\b/i.test(clean) ||
                               /test_pic|streamtest|livetest|\/test\.m3u8|\/test\//i.test(parsed.url);
          if (isTestOrDemo) {
            curMeta = null;
            curOpts = {};
            continue;
          }

          const cat     = this.normalizeCategory(curMeta.group, clean);
          const mapKey  = `${cat}:${clean.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

          const resMatch = (curMeta.rawTitle || '').match(/\b(1080p|720p|540p|480p|360p|240p|144p)\b/i);
          const resTag   = resMatch ? resMatch[1].toUpperCase() : 'HD';

          // For SKTech/FanCode, 720p and 1080p work — drop lower resolutions (540p, 480p, 360p, 240p, 144p)
          if (resMatch && resTag !== '1080P' && resTag !== '720P') {
            curMeta = null;
            curOpts = {};
            continue;
          }

          const langKey  = (curMeta.lang || 'def').toLowerCase();
          const srcId    = `m3u_${feedKey}_${curMeta.tvgId || Math.random().toString(36).slice(2, 8)}_${resTag}_${langKey}`;

          const streamTitle = curMeta.lang && curMeta.lang.toLowerCase() !== 'english'
            ? `SK Tech (${feed.label} ${resTag} - ${curMeta.lang})`
            : (resTag !== 'HD' ? `SK Tech (${feed.label} ${resTag})` : `SK Tech (${feed.label})`);

          const srcObj = {
            source:        'sktech',
            id:            srcId,
            feedLabel:     feed.label,
            langKey,
            channelName:   `${feed.label} (${resTag})`,
            resolution:    resTag,
            type:          'fancode_direct',
            streamUrl:     parsed.url,
            streamHeaders: { 'User-Agent': DEFAULT_UA, ...curOpts, ...parsed.headers },
            streamTitle
          };

          this._eventStreamCache.set(srcId, srcObj);

          if (matchMap.has(mapKey)) {
            const matchObj = matchMap.get(mapKey);
            // Quality deduplication: per feed + language + resolution (preserve both 720P & 1080P)
            const existingIdx = matchObj.sources.findIndex(s =>
              s.source === 'sktech' &&
              s.type   === 'fancode_direct' &&
              (s.feedLabel === feed.label || (s.channelName && s.channelName.startsWith(feed.label))) &&
              s.langKey === langKey &&
              s.resolution === resTag
            );

            if (existingIdx === -1) {
              matchObj.sources.push(srcObj);
            }
          } else {
            const teamParts = clean.split(/\s+(?:vs?\.?|@|[-–—])\s+/i);
            const teamA = teamParts.length === 2 ? { name: teamParts[0].trim(), logo: '' } : null;
            const teamB = teamParts.length === 2 ? { name: teamParts[1].trim(), logo: '' } : null;

            const matchObj = {
              id:          `sktech_ev_${feedKey}_${curMeta.tvgId || Math.random().toString(36).slice(2, 8)}`,
              title:       clean,
              category:    cat,
              kickoff:     Date.now(),
              rawCategory: curMeta.group || `${feed.label} Live`,
              teamA,
              teamB,
              poster:      curMeta.logo,
              sources:     [srcObj]
            };

            matchMap.set(mapKey, matchObj);
            matches.push(matchObj);
          }
        }
        curMeta = null;
        curOpts = {};
      }
    }
  }

  /**
   * Fetches and unpacks discrete live sports events from dynamic M3U event feeds
   * (e.g. FanCode, Sony LIV) into distinct MatchEntities with playable direct HLS streams.
   *
   * @returns {Promise<Array<Object>>}
   */
  async fetchDynamicM3uMatches() {
    const now = Date.now();
    if (this._dynamicCache && (now - this._dynamicCacheTime < 180000)) {
      return this._dynamicCache;
    }

    const matches  = [];
    const matchMap = new Map();

    const feedPromises = DYNAMIC_EVENT_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { 'User-Agent': DEFAULT_UA },
          signal: AbortSignal.timeout(6000)
        });
        if (!res.ok) return;
        const text = await res.text();
        this.parseM3UContent(text, feed, matchMap, matches);
      } catch (_) {}
    });

    await Promise.allSettled(feedPromises);

    const cleanMatches = matches.filter(m => !/namibia\s*(?:vs?\.?|@|-)\s*uganda/i.test(m.title));

    this._dynamicCache    = cleanMatches;
    this._dynamicCacheTime = now;
    return cleanMatches;
  }

  /**
   * Unified ingestion of both Pillar 1A (events.txt) and Pillar 1B (FanCode & Sony LIV M3Us)
   * @returns {Promise<Array<Object>>}
   */
  async fetchLiveMatches() {
    const [eventsTxtMatches, dynamicM3uMatches] = await Promise.all([
      this.fetchEventsTxtMatches().catch(() => []),
      this.fetchDynamicM3uMatches().catch(() => [])
    ]);

    const unifiedMap = new Map();
    const result = [];

    const toKey = (cat, title) => `${cat || 'other'}:${this.cleanEventTitle(title).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

    for (const m of eventsTxtMatches) {
      const key = toKey(m.category, m.title);
      unifiedMap.set(key, m);
      result.push(m);
    }

    for (const m of dynamicM3uMatches) {
      const key = toKey(m.category, m.title);
      if (unifiedMap.has(key)) {
        const existing = unifiedMap.get(key);
        if (!existing.sources) {
          existing.sources = [{
            source: 'sktech',
            id: existing.linkPath,
            channelName: existing.title,
            type: 'fixture'
          }];
        }
        if (m.sources && m.sources.length > 0) {
          existing.sources.push(...m.sources);
        }
      } else {
        unifiedMap.set(key, m);
        result.push(m);
      }
    }

    return result;
  }

  /**
   * Resolves direct playable streams for a given event link definition (`pro/<id>.txt`)
   * Strict Constraints: 0 Server Bandwidth, 0 Cloudflare Workers
   * Prioritizes direct HLS streams first, followed by Cloudflare R2, embeds, and ClearKey DASH.
   *
   * @param {string} linkPath - Path to the event link file (e.g. `pro/xyz.txt`)
   * @param {string} matchTitle - Title of the fixture
   * @returns {Promise<Array<Object>>} Playable stream entities
   */
  async resolveMatchStreams(linkPath, matchTitle = '') {
    if (!linkPath) return [];

    let rawOptions = [];
    try {
      const url = linkPath.startsWith('http') ? linkPath : `${this.baseUrl}${linkPath}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA }
      });

      if (!res.ok) {
        return [];
      }

      const rawCiphertext = (await res.text()).trim();
      const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
      rawOptions = JSON.parse(decryptedJson);
    } catch (_) {
      return [];
    }

    const hlsStreams = [];
    const r2Streams = [];
    const embedStreams = [];
    const dashStreams = [];

    for (const opt of rawOptions) {
      const serverName = opt.name || 'HD Server';
      const rawLink = opt.link || '';
      const api = opt.api || '';
      const tokenApi = opt.tokenApi || '';

      // Case 1: Dynamic tokenApi Embed
      if (tokenApi) {
        try {
          const resolved = await SkTechEmbedExtractor.resolveTokenApi(tokenApi);
          if (resolved && resolved.url) {
            embedStreams.push({
              name: '⚡ Direct Stream',
              title: `SK Tech | ${serverName} (Web Source)`,
              url: resolved.url,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: {
                  request: resolved.headers
                }
              },
              score: 80
            });
          }
        } catch (_) {}
        continue;
      }

      if (!rawLink) continue;

      const parsed = SkTechEmbedExtractor.parseDelimited(rawLink);
      if (!parsed.url) continue;

      // Case 2: Cloudflare R2 Direct Video
      if (parsed.url.includes('.r2.dev')) {
        r2Streams.push({
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName ? `${serverName} • R2` : 'R2 Fast'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 95
        });
      }
      // Case 3: Akamai / AWS DASH with ClearKey → zero-bandwidth HLS conversion
      else if (parsed.url.includes('.mpd') && api && api.includes(':')) {
        const parts = api.trim().split(':');
        const kid = (parts[0] || '').trim();
        const key = (parts[1] || '').trim();

        if (/^[0-9a-fA-F]{32}$/.test(key)) {
          const payload = Buffer.from(JSON.stringify({
            mpdUrl: parsed.url,
            key: key.toLowerCase(),
            kid: kid.toLowerCase(),
            headers: parsed.headers || {}
          })).toString('base64url');

          dashStreams.push({
            name: '⚡ Direct Stream',
            title: `SK Tech (${serverName ? `${serverName} • 1080p FHD` : '1080p FHD'})`,
            url: `${BASE_URL}/api/dash/index.m3u8?d=${payload}`,
            behaviorHints: { notWebReady: false },
            score: 95
          });
        }
        // .mpd with a malformed key stays unplayable — dropped, never emitted raw
      }
      // Case 3b: DASH without any ClearKey cannot be played natively — skip
      else if (parsed.url.includes('.mpd')) {
        continue;
      }
      // Case 4: Standard Direct HLS (.m3u8)
      else if (parsed.url.includes('.m3u8') || parsed.url.includes('amagi.tv') || parsed.url.includes('redbull.tv')) {
        hlsStreams.push({
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName || 'HLS Server'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 90
        });
      }
      // Case 5: Generic direct link
      else {
        hlsStreams.push({
          name: '⚡ Direct Stream',
          title: `SK Tech (${serverName || 'Live Server'})`,
          url: parsed.url,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: parsed.headers
            }
          },
          score: 85
        });
      }
    }

    // Prioritize direct HLS & R2 first, then embeds, then DASH ClearKey
    return [...hlsStreams, ...r2Streams, ...embedStreams, ...dashStreams];
  }
}

module.exports = new SkTechMatchResolver();
