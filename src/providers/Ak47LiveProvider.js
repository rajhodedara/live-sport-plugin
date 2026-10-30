'use strict';

const crypto = require('crypto');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { BASE_URL } = require('../config');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const DEFAULT_REFERER = 'http://www.fawanews.sc/';
const DEFAULT_ORIGIN = 'http://www.fawanews.sc';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const PLAYLIST_FEEDS = [
  'https://fawasp.pages.dev/playlist.txt',
  'https://axsp.pages.dev/playlist.txt'
];

const EVENTS_URL = 'https://hellobabu.xyz/events.txt';
const AK47_BASE_URL = 'https://hellobabu.xyz';
const AK47_KEY = Buffer.from('az1sUE8zNnNUVXpN', 'ascii');
const AK47_IV = Buffer.from('dz00QVhsNmZZU0Fw', 'ascii');

class Ak47LiveProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Ak47Live';
    this._cache = null;
    this._lastFetchTime = 0;
    let ttl = 180000;
    try {
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'cacheTtlMs')) {
        ttl = opts.cacheTtlMs;
      }
    } catch (_) {}
    this._cacheTtlMs = ttl;
  }

  normalizeCategory(cat) {
    if (!cat) return 'other';
    const raw = String(cat).toLowerCase();
    if (/(?:premier\s*league|la\s*liga|serie\s*a|bundesliga|ligue\s*1|champions\s*league|europa|conference\s*league|fa\s*cup|copa|a-league|aleague|mls|eredivisie|scotland)/i.test(raw)) {
      return 'football';
    }
    return super.normalizeCategory(cat);
  }

  /**
   * Decrypts obfuscated AK47 payloads (events.txt, pro/*.txt).
   * Reverses base64 encoding with adjacent byte pair swapping, then performs AES-128-CBC.
   */
  _decryptAk47Payload(rawBase64) {
    if (!rawBase64 || typeof rawBase64 !== 'string') return null;
    try {
      const b1 = Buffer.from(rawBase64.trim(), 'base64');
      for (let i = 0; i < b1.length - 1; i += 2) {
        const tmp = b1[i];
        b1[i] = b1[i + 1];
        b1[i + 1] = tmp;
      }
      b1.reverse();
      const ciphertext = Buffer.from(b1.toString('ascii'), 'base64');
      const decipher = crypto.createDecipheriv('aes-128-cbc', AK47_KEY, AK47_IV);
      decipher.setAutoPadding(true);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch (_) {
      return null;
    }
  }

  /**
   * Parse an M3U playlist text into structured stream entries.
   * Extracts #EXTVLCOPT headers, #EXTINF metadata, and stream URLs.
   * Enforces strict Zero-DASH filter (discards .mpd and /dash/ links).
   */
  _parseM3u(content) {
    if (!content || typeof content !== 'string') return [];

    const lines = content.split(/\r?\n/);
    const entries = [];
    let currentVlcOpts = {};
    const readVlcOpt = line => {
      const optLine = line.substring(11).trim();
      const eqIdx = optLine.indexOf('=');
      if (eqIdx === -1) return;
      const key = optLine.substring(0, eqIdx).trim().toLowerCase();
      const val = optLine.substring(eqIdx + 1).trim();
      if (key === 'http-referrer' || key === 'http-referer') currentVlcOpts.referer = val;
      else if (key === 'http-origin') currentVlcOpts.origin = val;
      else if (key === 'http-user-agent') currentVlcOpts.userAgent = val;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTVLCOPT:')) {
        readVlcOpt(line);
        continue;
      }

      if (line.startsWith('#EXTINF:')) {
        const infLine = line;
        // Group title
        const groupMatch = infLine.match(/group-title="([^"]*)"/i);
        const groupTitle = groupMatch ? groupMatch[1].trim() : 'Other';

        // tvg-name
        const nameMatch = infLine.match(/tvg-name="([^"]*)"/i);
        const tvgName = nameMatch ? nameMatch[1].trim() : '';

        // tvg-logo
        const logoMatch = infLine.match(/tvg-logo="([^"]*)"/i);
        const tvgLogo = logoMatch ? logoMatch[1].trim() : '';

        // Display name after comma
        const commaIdx = infLine.lastIndexOf(',');
        const rawTitle = commaIdx !== -1 ? infLine.substring(commaIdx + 1).trim() : tvgName;

        // Next non-comment line is the stream URL
        let streamUrl = '';
        while (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          if (nextLine.startsWith('#EXTINF:')) break;
          if (nextLine.startsWith('#EXTVLCOPT:')) readVlcOpt(nextLine);
          if (nextLine && !nextLine.startsWith('#')) {
            streamUrl = nextLine;
            i++;
            break;
          }
          i++;
        }

        if (!streamUrl) { currentVlcOpts = {}; continue; }

        // Strict Zero-DASH filter: discard MPEG-DASH manifests and CENC DRM URLs
        if (/\.mpd(\?|$)/i.test(streamUrl) || /\/dash\//i.test(streamUrl) || /cenc/i.test(streamUrl)) {
          currentVlcOpts = {};
          continue;
        }

        // Must be valid HLS (.m3u8) or HTTP live video stream
        if (!/^https?:\/\//i.test(streamUrl)) {
          currentVlcOpts = {};
          continue;
        }

        entries.push({
          rawTitle: rawTitle || tvgName,
          groupTitle,
          tvgLogo,
          streamUrl,
          referer: currentVlcOpts.referer || DEFAULT_REFERER,
          origin: currentVlcOpts.origin || DEFAULT_ORIGIN,
          userAgent: currentVlcOpts.userAgent || DEFAULT_UA
        });

        currentVlcOpts = {};
      }
    }

    return entries;
  }

  /**
   * Deconstructs raw title into base match title, clean teams, and channel label.
   * e.g. "Boxing : Fundora vs Hadribeaj --- CH 1" ->
   *   cleanTitle: "Fundora vs Hadribeaj", channelLabel: "CH 1"
   */
  _extractMatchInfo(rawTitle, groupTitle) {
    let title = rawTitle || '';

    // Extract channel suffix (e.g. "--- CH 1", "--- CH 2", "- CH 1", "CH 1")
    let channelLabel = 'HD';
    const chMatch = title.match(/[-–—\s]+(CH\s*\d+|Server\s*\d+|HD\s*SERVER\s*\d+|PPV\s*\d*)/i);
    if (chMatch) {
      channelLabel = chMatch[1].trim();
      title = title.replace(chMatch[0], '').trim();
    }

    // Strip redundant leading sport category prefix (e.g. "Boxing : ", "MMA : ")
    title = title.replace(/^(?:Boxing|MMA|UFC|AEW|WWE|Football|Soccer|Basketball|Baseball|Hockey)\s*:\s*/i, '').trim();

    // Clean up trailing dashes or delimiters
    title = title.replace(/[-–—\s]+$/, '').trim();

    // Parse team1 and team2 using TeamNameExtractor if possible, or fallback regex
    let team1 = null;
    let team2 = null;
    const derived = extractTeamsFromTitle(title);
    if (derived && derived.length === 2) {
      team1 = derived[0];
      team2 = derived[1];
    } else {
      const vsMatch = title.match(/^(.+?)\s+(?:vs\.?|v\.?|@)\s+(.+?)$/i);
      if (vsMatch) {
        team1 = vsMatch[1].trim();
        team2 = vsMatch[2].trim();
      }
    }

    // Canonical category
    const category = this.normalizeCategory(groupTitle);

    return {
      title: title || rawTitle,
      channelLabel,
      team1,
      team2,
      category
    };
  }

  /**
   * Ingests and aggregates live matches from AK47 encrypted events and M3U playlists.
   * Deduplicates multiple stream channels under single MatchEntity cards.
   */
  async getMatches() {
    const now = Date.now();
    if (this._cache && (now - this._lastFetchTime) < this._cacheTtlMs) {
      return this._cache;
    }

    const matchesMap = new Map();
    const finishedSlugs = new Set();
    const finishedTeamPairs = new Set();
    const knownEventMap = new Map();

    // 1. Ingest Decrypted Events Feed from hellobabu.xyz/events.txt
    try {
      const res = await this.proxyFetch(EVENTS_URL, {
        headers: { 'User-Agent': 'okhttp/4.9.2' },
        timeoutMs: 8000,
        attempts: 2
      });
      if (res && res.status === 200) {
        const rawBody = await res.text();
        const events = this._decryptAk47Payload(rawBody);
        if (Array.isArray(events)) {
          for (const item of events) {
            const evStr = item.event;
            const ev = typeof evStr === 'string' ? JSON.parse(evStr) : evStr;
            if (!ev || ev.visible === false || !ev.teamAName || !ev.teamBName) continue;

            let matchDateMs = 0;
            if (ev.date && ev.time) {
              const dParts = ev.date.split('/').map(Number);
              const tParts = ev.time.split(':').map(Number);
              if (dParts.length === 3 && dParts[0] && dParts[1] && dParts[2]) {
                const dt = new Date(Date.UTC(dParts[2], dParts[1] - 1, dParts[0], tParts[0] || 0, tParts[1] || 0, tParts[2] || 0));
                if (!isNaN(dt.getTime())) matchDateMs = dt.getTime();
              }
            }

            let endDateMs = 0;
            if (ev.end_date && ev.end_time) {
              const dParts = ev.end_date.split('/').map(Number);
              const tParts = ev.end_time.split(':').map(Number);
              if (dParts.length === 3 && dParts[0] && dParts[1] && dParts[2]) {
                const dt = new Date(Date.UTC(dParts[2], dParts[1] - 1, dParts[0], tParts[0] || 0, tParts[1] || 0, tParts[2] || 0));
                if (!isNaN(dt.getTime())) endDateMs = dt.getTime();
              }
            }

            const t1Raw = ev.teamAName.trim();
            const t2Raw = ev.teamBName.trim();
            const isMatchup = Boolean(t1Raw && t2Raw && t1Raw.toLowerCase() !== t2Raw.toLowerCase());
            const title = isMatchup ? `${t1Raw} vs ${t2Raw}` : (ev.eventName ? ev.eventName.trim() : t1Raw);
            const matchSlug = this.normalizeStr(title) || 'match';
            const matchId = `ak47_${matchSlug.replace(/\s+/g, '_')}`;

            // Omit events that finished more than 30 mins ago
            const isFinished = endDateMs > 0
              ? (now > endDateMs + 30 * 60 * 1000)
              : (matchDateMs > 0 ? (now > matchDateMs + 4 * 60 * 60 * 1000) : false);
            if (isFinished) {
              finishedSlugs.add(matchSlug);
              if (t1Raw && t2Raw) {
                const normT1 = this.normalizeStr(t1Raw);
                const normT2 = this.normalizeStr(t2Raw);
                finishedTeamPairs.add(`${normT1}|${normT2}`);
                finishedTeamPairs.add(`${normT2}|${normT1}`);
              }
              continue;
            }

            const status = matchDateMs > 0 ? (now < matchDateMs ? 'UPCOMING' : 'LIVE') : 'LIVE';
            const matchDate = matchDateMs > 0 ? String(matchDateMs) : '0';
            knownEventMap.set(matchSlug, { matchDate, status });
            if (t1Raw && t2Raw) {
              const normT1 = this.normalizeStr(t1Raw);
              const normT2 = this.normalizeStr(t2Raw);
              knownEventMap.set(`${normT1}|${normT2}`, { matchDate, status });
              knownEventMap.set(`${normT2}|${normT1}`, { matchDate, status });
            }

            const team1 = isMatchup ? { name: t1Raw } : null;
            const team2 = isMatchup ? { name: t2Raw } : null;
            const category = this.normalizeCategory(ev.category || 'Football');
            const league = ev.eventName ? ev.eventName.trim() : '';

            const linkNames = Array.isArray(ev.link_names) ? ev.link_names : [];
            const linksPath = ev.links || '';

            const sources = [];
            if (linkNames.length > 0 && linksPath) {
              linkNames.forEach((name, idx) => {
                sources.push({
                  source: 'ak47live',
                  id: `${linksPath}#${idx}`,
                  channelName: name.trim(),
                  linksPath,
                  streamIndex: idx,
                  type: 'live'
                });
              });
            } else if (linksPath) {
              sources.push({
                source: 'ak47live',
                id: linksPath,
                channelName: 'HD',
                linksPath,
                streamIndex: 0,
                type: 'live'
              });
            }

            if (matchesMap.has(matchId)) {
              const existing = matchesMap.get(matchId);
              for (const src of sources) {
                const hasSrc = existing.sources.some(s => s.id === src.id);
                if (!hasSrc) existing.sources.push(src);
              }
            } else {
              const match = new MatchEntity({
                id: matchId,
                title,
                category,
                league,
                date: matchDate,
                status,
                team1,
                team2,
                thumbnail_url: ev.eventLogo || ev.teamAFlag || '',
                poster: '',
                sources
              });
              matchesMap.set(matchId, match);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] Events fetch failed: ${err.message}`);
    }

    // 2. Ingest Playlist Feeds (fawasp / axsp)
    await Promise.all(
      PLAYLIST_FEEDS.map(async (feedUrl) => {
        try {
          const res = await this.proxyFetch(feedUrl, {
            headers: { 'User-Agent': 'okhttp/4.9.2' },
            timeoutMs: 6000,
            attempts: 2
          });

          if (!res || res.status !== 200) return;
          const text = await res.text();
          const entries = this._parseM3u(text);

          for (const entry of entries) {
            const { title, channelLabel, team1, team2, category } = this._extractMatchInfo(entry.rawTitle, entry.groupTitle);

            const matchSlug = this.normalizeStr(title) || 'match';
            const matchId = `ak47_${matchSlug.replace(/\s+/g, '_')}`;

            const tPair1 = (team1 && team2) ? `${this.normalizeStr(team1)}|${this.normalizeStr(team2)}` : null;
            const tPair2 = (team1 && team2) ? `${this.normalizeStr(team2)}|${this.normalizeStr(team1)}` : null;

            if (finishedSlugs.has(matchSlug) || (tPair1 && (finishedTeamPairs.has(tPair1) || finishedTeamPairs.has(tPair2)))) {
              continue; // Finished in Section 1; skip resurrecting
            }

            const sourceObj = {
              source: 'ak47live',
              id: entry.streamUrl,
              channelName: channelLabel,
              referer: entry.referer,
              origin: entry.origin,
              userAgent: entry.userAgent,
              type: 'live'
            };

            if (matchesMap.has(matchId)) {
              const existing = matchesMap.get(matchId);
              const hasUrl = existing.sources.some(s => s.id === entry.streamUrl);
              if (!hasUrl) {
                existing.sources.push(sourceObj);
              }
            } else {
              const known = knownEventMap.get(matchSlug) || (tPair1 && (knownEventMap.get(tPair1) || knownEventMap.get(tPair2)));
              const matchDate = known ? known.matchDate : '0';
              const status = known ? known.status : 'LIVE';
              const isMatchup = Boolean(team1 && team2);
              const match = new MatchEntity({
                id: matchId,
                title,
                category,
                league: entry.groupTitle || '',
                date: matchDate,
                status,
                team1: team1 ? { name: team1 } : null,
                team2: team2 ? { name: team2 } : null,
                thumbnail_url: isMatchup ? '' : (entry.tvgLogo || ''),
                poster: '',
                sources: [sourceObj]
              });
              matchesMap.set(matchId, match);
            }
          }
        } catch (err) {
          console.warn(`[${this.name}] Feed fetch failed for ${feedUrl}: ${err.message}`);
        }
      })
    );

    const matches = Array.from(matchesMap.values());
    this._cache = matches;
    this._lastFetchTime = now;
    return matches;
  }

  /**
   * Resolves a stream source into a playable StreamEntity with proxy headers.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    let streamUrl = src.id || sourceId;
    let referer = src.referer || DEFAULT_REFERER;
    let origin = src.origin || DEFAULT_ORIGIN;
    let userAgent = src.userAgent || DEFAULT_UA;
    let channelLabel = src.channelName || 'HD';

    // If source points to encrypted pro/*.txt feed:
    if (src.linksPath || (typeof streamUrl === 'string' && streamUrl.startsWith('pro/'))) {
      const linksPath = src.linksPath || streamUrl.split('#')[0];
      const targetIdx = src.streamIndex !== undefined ? src.streamIndex : 0;
      try {
        const proUrl = `${AK47_BASE_URL}/${linksPath}`;
        const res = await this.proxyFetch(proUrl, {
          headers: { 'User-Agent': 'okhttp/4.9.2' },
          timeoutMs: 6000,
          attempts: 2
        });
        if (res && res.status === 200) {
          const raw = await res.text();
          const streams = this._decryptAk47Payload(raw);
          if (Array.isArray(streams) && streams.length > 0) {
            let selected = streams[targetIdx] || streams.find(s => s.name && s.name.trim() === channelLabel) || streams[0];
            if (selected) {
              channelLabel = selected.name ? selected.name.trim() : channelLabel;

              // ClearKey DASH (.mpd + 16-byte hex key): convert to zero-bandwidth
              // HLS via /api/dash — segments stream directly from the upstream CDN.
              // AK47 feeds carry the key as api:"<kid>:<key>" (same format as SK Tech);
              // key/kid fields are honoured too when present.
              const linkParts = String(selected.link || '').split('|');
              const dashLink = linkParts[0].trim();
              let clearKey = '';
              let clearKid = '';
              if (typeof selected.api === 'string' && selected.api.includes(':')) {
                const apiParts = selected.api.trim().split(':');
                clearKid = apiParts[0].trim();
                clearKey = apiParts[1].trim();
              } else {
                clearKey = String(selected.key || '').trim();
                clearKid = String(selected.kid || '').trim();
              }
              if (/^[0-9a-fA-F]{32}$/.test(clearKey) && /\.mpd(\?|$)/i.test(dashLink)) {
                const dashHeaders = { 'User-Agent': DEFAULT_UA };
                for (const pair of linkParts.slice(1).join('|').split('&')) {
                  const eqIdx = pair.indexOf('=');
                  if (eqIdx !== -1 && pair.substring(0, eqIdx).trim().toLowerCase() === 'user-agent') {
                    dashHeaders['User-Agent'] = pair.substring(eqIdx + 1).trim();
                  }
                }

                const payload = Buffer.from(JSON.stringify({
                  mpdUrl: dashLink,
                  key: clearKey.toLowerCase(),
                  kid: clearKid.toLowerCase(),
                  headers: dashHeaders
                })).toString('base64url');

                return [new StreamEntity({
                  name: 'Ak47Live',
                  // Channel name inside () — the stream pipeline extracts the
                  // first parenthesised group as the displayed channel label.
                  title: `${matchTitle || 'Live Event'} (${channelLabel})`,
                  url: `${BASE_URL}/api/dash/index.m3u8?d=${payload}`,
                  behaviorHints: { notWebReady: false },
                  resolution: 'FHD'
                })];
              }

              // Zero-DASH / DRM Enforcement: Drop any remaining DRM or DASH stream
              // (Widevine/PlayReady without a usable ClearKey, malformed keys).
              if (selected.drm_scheme || selected.key || selected.kid) {
                console.warn(`[${this.name}] Dropped DASH / DRM stream: ${channelLabel}`);
                return [];
              }

              // Reject embed.st or any WASM-based feeds
              const tokenApiStr = typeof selected.tokenApi === 'string'
                ? selected.tokenApi
                : (selected.tokenApi ? JSON.stringify(selected.tokenApi) : '');

              if (
                /embed\.st|embedindia\.st|strmd\.st|gasm|wasm/i.test(selected.link || '') ||
                /embed\.st|embedindia\.st|strmd\.st|gasm|wasm/i.test(tokenApiStr)
              ) {
                console.warn(`[${this.name}] Dropped embed.st / WASM stream: ${channelLabel}`);
                return [];
              }

              if (selected.link) {
                const parts = selected.link.split('|');
                streamUrl = parts[0].trim();
                if (parts.length > 1) {
                  const headerPairs = parts.slice(1).join('|').split('&');
                  for (const pair of headerPairs) {
                    const eqIdx = pair.indexOf('=');
                    if (eqIdx !== -1) {
                      const k = pair.substring(0, eqIdx).trim().toLowerCase();
                      const v = pair.substring(eqIdx + 1).trim();
                      if (k === 'referer' || k === 'http-referrer') referer = v;
                      else if (k === 'origin' || k === 'http-origin') origin = v;
                      else if (k === 'user-agent' || k === 'http-user-agent') userAgent = v;
                    }
                  }
                }
              } else if (selected.tokenApi) {
                try {
                  const tokenObj = typeof selected.tokenApi === 'string' ? JSON.parse(selected.tokenApi) : selected.tokenApi;
                  if (tokenObj && tokenObj.api) {
                    // Skip if the target API is embed.st or WASM
                    if (/embed\.st|embedindia\.st|strmd\.st|gasm|wasm/i.test(tokenObj.api)) {
                      console.warn(`[${this.name}] Dropped embed.st tokenApi: ${tokenObj.api}`);
                      return [];
                    }
                    const tokenRes = await this.proxyFetch(tokenObj.api, {
                      headers: { 'User-Agent': DEFAULT_UA, 'Referer': 'https://hellobabu.xyz/' },
                      timeoutMs: 5000,
                      attempts: 2
                    });
                    if (tokenRes && tokenRes.status === 200) {
                      const tokenBody = await tokenRes.text();
                      let directLink = '';
                      try {
                        const parsedJson = JSON.parse(tokenBody);
                        directLink = parsedJson.playback_url || parsedJson.url || '';
                      } catch (_) {
                        const matchHls = tokenBody.match(/hlsManifestUrl":"([^"]+)"/);
                        if (matchHls) directLink = matchHls[1];
                      }
                      if (directLink) streamUrl = directLink;
                    }
                  }
                } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[${this.name}] Pro stream resolve failed for ${linksPath}: ${err.message}`);
      }
    }

    if (!streamUrl || typeof streamUrl !== 'string' || !streamUrl.startsWith('http')) {
      return [];
    }

    // Zero-DASH Enforcement: Reject any DASH streams
    if (/\.mpd(\?|$)/i.test(streamUrl) || /\/dash\//i.test(streamUrl) || /cenc/i.test(streamUrl)) {
      console.warn(`[${this.name}] Dropped DASH stream: ${streamUrl}`);
      return [];
    }

    // Filter out embed.st or WASM-based streams
    if (/embed\.st|embedindia\.st|strmd\.st|gasm|wasm/i.test(streamUrl)) {
      console.warn(`[${this.name}] Dropped embed.st / WASM stream: ${streamUrl}`);
      return [];
    }

    const { manifestUserAgent } = require('../services/ManifestUserAgent');
    // The provider injects DEFAULT_UA even when no source specified one. Keep
    // the proxy's historical default in that case.
    const manifestUa = userAgent === DEFAULT_UA ? '' : manifestUserAgent(userAgent);
    const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}${manifestUa ? `&hlsua=${encodeURIComponent(manifestUa)}` : ''}`;

    const stream = new StreamEntity({
      name: 'Ak47Live',
      title: `[${channelLabel}] ${matchTitle || 'Live Event'} (HD)`,
      url: proxyUrl,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            'Referer': referer,
            'Origin': origin,
            'User-Agent': userAgent
          }
        }
      },
      resolution: 'HD'
    });

    return [stream];
  }
}

module.exports = Ak47LiveProvider;
