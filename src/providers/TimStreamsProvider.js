const { safeFetch } = require('../services/ProviderOutbound');
const BaseProvider = require('./BaseProvider');
const { isInconclusiveResolutionError } = require('../services/StreamResolutionOutcome');
const MatchEntity = require('../domain/MatchEntity');
const { parseTimezone } = require('../timezone');
const { BASE_URL } = require('../config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

class TimStreamsProvider extends BaseProvider {
  constructor(opts) {
    super(opts || {});
    this.name = 'TimStreams';
    // Measured quality for single-rendition playlists (see HlsQualityProbe).
    // Injected from the container; absent in unit tests, where the probe is
    // skipped and rows keep the previous 'HD' fallback.
    this.hlsQualityProbe = (opts && opts.hlsQualityProbe) || null;
    // Upstream moved to a new host: timst.top no longer resolves. The API
    // path and payload shape are unchanged, so only the host changes here.
    this.apiUrl = 'https://tim-streams.com/api/live-upcoming';
    
    this.fetchData = this.circuitBreaker.wrapSync(`${this.name}_fetch`, async () => {
      const res = await this.proxyFetch(this.apiUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!data || !Array.isArray(data.events)) return [];

      const genres = data.genres || {};
      
      data.events.forEach((s, index) => {
        if (!s || typeof s !== 'object') return;
        const title = typeof s.name === 'string' && s.name ? s.name : `TimStreams Event ${index}`;
        let rawGenre = s.genre;
        let genreLabel = 'other';
        if (Array.isArray(genres)) {
          const matchedGenre = genres.find(g => g && g.id === rawGenre);
          if (matchedGenre && matchedGenre.name) {
            genreLabel = matchedGenre.name;
          }
        } else if (typeof rawGenre === 'object' && rawGenre !== null && !Array.isArray(rawGenre)) {
          genreLabel = rawGenre.name || rawGenre.title || 'other';
        } else {
          genreLabel = String(genres[String(rawGenre)]?.name || genres[String(rawGenre)] || rawGenre || 'other');
        }
        
        const category = this.normalizeCategory(genreLabel);
        
        let dateMs = null;
        if (s.time) {
          const parsed = parseTimezone(s.time, 'America/New_York');
          if (parsed && !isNaN(parsed) && parsed > 0) {
            dateMs = parsed;
          } else {
            const rawTime = new Date(s.time).getTime();
            if (!isNaN(rawTime) && rawTime > 0) {
              dateMs = rawTime;
            }
          }
        }

        const now = Date.now();
        const maxDuration = 4 * 60 * 60 * 1000;
        let isLive = false;
        let status = 'upcoming';

        if (dateMs !== null) {
          if (dateMs <= now && (now - dateMs) <= maxDuration) {
            isLive = true;
            status = 'live';
          } else if (dateMs > now) {
            status = 'upcoming';
          } else {
            // Event kicked off > 4 hours ago; TimStreams is a live/upcoming scraper, not a replay archive
            return;
          }
        }

        const sources = (Array.isArray(s.streams) ? s.streams : [])
          .filter(st => st && typeof st === 'object' && !st.vip && (st.url == null || typeof st.url === 'string'))
          .map(st => {
            let id = st.name || 'Stream';
            if (st.url) {
               id = Buffer.from(st.url).toString('hex');
            }
            return {
              source: 'timstreams',
              id: id,
              // Upstream already names the broadcaster ("TNT Sports 1",
              // "Sky Sports+", "Board 1"). Keep it on the source so the stream
              // row can label the feed instead of showing only the event name.
              name: st.name || 'Stream',
              channelName: st.name || 'Stream',
              url: st.url
            };
          });

        if (sources.length > 0) {
          matches.push(new MatchEntity({
            id: `ts_${s.url || index}`,
            title: title,
            category: category,
            date: dateMs ? dateMs.toString() : '',
            status: status,
            popular: (isLive && s.featured) ? '1' : '0',
            sources: sources,
            thumbnail_url: s.logo || ''
          }));
        }
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.stack);
    }
    return matches;
  }

  /**
   * Decode a XOR-obfuscated script block from TimStreams embed pages.
   */
  decodeObfuscatedScript(html) {
    // 1. Find the obfuscated array
    const arrMatch = html.match(/var\s+\w+\s*=\s*\[([\d,\s]+)\]/);
    if (!arrMatch) return null;
    const arr = arrMatch[1].split(',').map(Number);
    
    // 2. Find the character decoding loop formula to get the variable names
    // Typically: String.fromCharCode(((_so7[_ix3]^_bw9)-_jr2+256)%256) or &255
    const loopMatch = html.match(/String\.fromCharCode\(\s*\(+[^\^]+\^\s*(\w+)\s*\)\s*-\s*(\w+)\s*\+\s*256\s*\)\s*(?:%|&)\s*(?:256|255)\)/);
    if (!loopMatch) return null;
    
    const xorVarName = loopMatch[1];
    const subVarName = loopMatch[2];
    
    // 3. Find the integer values assigned to those variables
    const xorRegex = new RegExp(xorVarName + '\\s*=\\s*(\\d+)');
    const subRegex = new RegExp(subVarName + '\\s*=\\s*(\\d+)');
    
    const xorMatch = html.match(xorRegex);
    const subMatch = html.match(subRegex);
    
    if (!xorMatch || !subMatch) return null;
    
    const xor = parseInt(xorMatch[1]);
    const sub = parseInt(subMatch[1]);

    // 4. Decrypt natively in Node.js!
    let decoded = '';
    for (let i = 0; i < arr.length; i++) {
      decoded += String.fromCharCode(((arr[i] ^ xor) - sub + 256) % 256);
    }
    return decoded;
  }

  /**
   * Extract the signed m3u8 URL from a TimStreams embed page natively.
   */
  async extractM3u8(embedUrl) {
    try {
      const res = await this.proxyFetch(embedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': 'https://tim-streams.com/'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!res.ok) return null;
      const html = await res.text();

      const decoded = this.decodeObfuscatedScript(html);
      if (!decoded) return null;

      let m3u8Url = null;
      const urlMatch = decoded.match(/https?:\/\/[^\x22\x27<>\s]+\.m3u8[^\x22\x27<>\s]*/);
      if (urlMatch) {
        m3u8Url = urlMatch[0];
      } else {
        const loadMatch = decoded.match(/loadStreamUrl\s*\(\s*["']([^"']+)["']/);
        if (loadMatch) {
          const tokenUrl = loadMatch[1];
          const tokenRes = await this.proxyFetch(tokenUrl, {
            headers: {
              'Referer': embedUrl,
              'Origin': new URL(embedUrl).origin,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(10000)
          });
          if (tokenRes.ok) {
            const buf = Buffer.from(await tokenRes.arrayBuffer());
            if (buf.length > 1) {
              const tk = tokenUrl.substring(tokenUrl.lastIndexOf('/') + 1);
              const s = buf[0];
              let decrypted = '';
              for (let i = 1; i < buf.length; i++) {
                decrypted += String.fromCharCode(buf[i] ^ tk.charCodeAt((i - 1) % tk.length) ^ ((s + i - 1) & 255));
              }
              const mMatch = decrypted.match(/https?:\/\/[^\x22\x27<>\s]+\.m3u8[^\x22\x27<>\s]*/);
              if (mMatch) {
                m3u8Url = mMatch[0];
              }
            }
          }
        }
      }

      if (!m3u8Url) return null;
      const embedDomain = new URL(embedUrl).origin;
      return { m3u8: m3u8Url, referer: embedDomain };
    } catch (e) {
      // A local capacity/timeout failure did NOT establish that the embed has
      // no playable HLS. Let streams.js defer its cache verdict and retry soon.
      // Definite extraction failures retain the existing web-player fallback.
      if (isInconclusiveResolutionError(e)) throw e;
      console.warn(`[${this.name}] m3u8 extraction failed for ${embedUrl}:`, e.message);
      return null;
    }
  }

  /**
   * Resolve one TimStreams source into player rows.
   *
   * `src` is the catalog source object ({ id, name, url }) and carries the upstream
   * broadcaster label ("TNT Sports 1", "Sky Sports+", "Board 3") that getMatches()
   * stored from streams[].name. Without it the row had no channel at all — and the
   * provider re-downloaded the entire 40-event schedule just to recover the embed URL.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = null, sourceName = 'timstreams') {
    const streams = [];
    const srcObj = src && typeof src === 'object' ? src : {};
    const rowTitle = matchTitle || 'Live Event';

    try {
      let embeds = [];
      const srcChannel = this.formatChannelLabel(srcObj.name);
      const srcUrl = typeof srcObj.url === 'string' ? srcObj.url
        : (typeof srcObj.embedUrl === 'string' ? srcObj.embedUrl : '');
      if (/^https?:\/\//i.test(srcUrl)) {
        embeds = [{ name: srcChannel || 'Stream', channel: srcChannel, url: srcUrl }];
      }

      if (embeds.length === 0) {
        try {
          const decoded = Buffer.from(sourceId, 'hex').toString('utf-8');
          if (decoded.startsWith('http')) {
            embeds = [{ name: 'Stream', channel: srcChannel, url: decoded }];
          }
        } catch (e) {}
      }

      if (embeds.length === 0) {
        const matches = await this.getMatches();
        const match = matches.find(m => m.id === `ts_${sourceId}` || m.sources.some(s => s.id === sourceId));

        if (match) {
          const specific = match.sources.find(s => s.id === sourceId && s.url);
          const list = specific ? [specific] : match.sources.filter(s => s.url);
          embeds = list.map(s => ({
            name: s.name || s.id,
            channel: this.formatChannelLabel(s.channelName || s.name),
            url: s.url
          }));
        }
      }

      if (embeds.length === 0) {
        embeds = [{ name: sourceId, channel: srcChannel, url: `https://logic.icelanders.st/embed/${sourceId}` }];
      }

      // Each feed is an independent embed -> m3u8 -> quality chain. Running them
      // together keeps the added probe cost at one probe, not one per feed.
      const perEmbed = await Promise.allSettled(embeds.map(embed => this.buildRowsForEmbed(embed, rowTitle)));
      let inconclusive = null;
      for (const result of perEmbed) {
        if (result.status === 'fulfilled') {
          streams.push(...result.value);
        } else if (isInconclusiveResolutionError(result.reason)) {
          // One bad embed must not discard other verified direct feeds.
          inconclusive ||= result.reason;
        } else {
          console.warn(`[${this.name}] embed resolution failed:`, result.reason?.message);
        }
      }
      // When only web fallback(s) survived a temporary transport failure,
      // caching them as a complete success hides the missing direct feed for
      // the entire positive TTL. Propagate only if no direct feed succeeded.
      if (inconclusive && !streams.some(row => row && row.url)) throw inconclusive;
    } catch (err) {
      if (isInconclusiveResolutionError(err)) throw err;
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }

  /**
   * One embed URL -> the player rows for that feed (direct + web fallback).
   */
  async buildRowsForEmbed(embed, matchTitle) {
    const StreamEntity = require('../domain/StreamEntity');
    const rows = [];
    const channel = this.formatChannelLabel(embed.channel || embed.name);

    let referer = '';
    try { referer = new URL(embed.url).origin; } catch (e) { referer = ''; }

    const nativeResult = await this.extractM3u8(embed.url);
    const m3u8Url = nativeResult ? nativeResult.m3u8 : null;
    if (nativeResult && nativeResult.referer) referer = nativeResult.referer;

    if (m3u8Url) {
      console.log(`[${this.name}] Extracted M3U8 for ${matchTitle}: ${m3u8Url}`);
      // A media playlist declares no quality, so measure the media itself. A null
      // result keeps the previous behaviour (HD, no bitrate) instead of guessing.
      const measured = await this.probeQuality(m3u8Url, referer);
      const origin = referer ? new URL(referer).origin : '';
      const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;

      rows.push(new StreamEntity({
        name: 'TimStreams',
        // The parenthesised channel is what streams.js lifts into the row label
        // (same shape Leaf uses). Without it the row showed no broadcaster at all.
        title: channel ? `(${channel}) ${matchTitle}` : `TimStreams ${matchTitle}`,
        url: proxyUrl,
        channelName: channel || undefined,
        canonicalChannel: channel || undefined,
        resolution: measured && measured.resolution ? measured.resolution : 'HD',
        quality: measured && measured.quality ? measured.quality : undefined,
        bitrate: measured && measured.bitrate ? measured.bitrate : undefined,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': UA,
              'Referer': referer,
              'Origin': origin
            }
          }
        },
        // Explicit source: the row title no longer contains "TimStreams" once a
        // channel is present, so the label lookup in streams.js needs this.
        _source: 'timstreams'
      }));
    }

    // Always add web fallback
    rows.push(new StreamEntity({
      name: `Nuvio Web Player`,
      title: `TimStreams (${channel || embed.name}) (Web)`,
      externalUrl: `/watch?url=${encodeURIComponent(embed.url)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
      channelName: channel || undefined,
      _source: 'timstreams'
    }));

    return rows;
  }

  /**
   * Measured resolution + bitrate for one media playlist. Never throws.
   */
  async probeQuality(manifestUrl, referer) {
    if (!this.hlsQualityProbe || typeof this.hlsQualityProbe.probe !== 'function') return null;
    try {
      let origin;
      try { origin = referer ? new URL(referer).origin : undefined; } catch (e) { origin = undefined; }
      return await this.hlsQualityProbe.probe(manifestUrl, {
        fetch: (url, opts) => this.proxyFetch(url, opts),
        referer,
        origin,
        userAgent: UA
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * Normalise the upstream feed label. Parentheses/brackets are stripped so they
   * cannot break streams.js' first-parens channel extraction.
   */
  formatChannelLabel(raw) {
    if (typeof raw !== 'string') return '';
    return raw
      .replace(/[()\[\]]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 60);
  }
}

module.exports = TimStreamsProvider;
