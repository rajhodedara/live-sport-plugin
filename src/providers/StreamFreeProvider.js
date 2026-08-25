const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class StreamFreeProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamFree';
    this.apiUrl = 'https://streamfree.top/streams';
    // Wrap the fetch with our circuit breaker
    this.fetchData = this.circuitBreaker.wrap(
      this.name + '_fetchMain',
      async () => {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };
        const res = await this.proxyFetch(this.apiUrl, { headers, signal: AbortSignal.timeout(7000) });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      }
    );
    this.embedFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchEmbed',
      async (url) => {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };
        const res = await this.proxyFetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.text();
      }
    );
    this.streamKeyFetcher = this.circuitBreaker.wrap(
      this.name + '_fetchStreamKey',
      async (url) => {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };
        const res = await this.proxyFetch(url, { headers, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      }
    );
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchData.fire();
      if (!data || !data.streams) return [];

      Object.entries(data.streams).forEach(([category, streams]) => {
        if (Array.isArray(streams)) {
          streams.forEach(s => {
            const id = s.stream_key || s.id;
            if (!id) return;
            matches.push(new MatchEntity({
              id: 'sf_' + id,
              title: s.name,
              category: this.normalizeCategory(category),
              date: s.match_timestamp ? (s.match_timestamp * 1000).toString() : null,
              popular: (s.viewers || 0) > 100 ? '1' : '0',
              league: s.league,
              team1: s.team1,
              team2: s.team2,
              thumbnail_url: s.thumbnail_url,
              sources: [{ source: 'streamfree', id: id, original_category: category }]
            }));
          });
        }
      });
    } catch (error) {
      console.error(`[${this.name}] Error fetching matches:`, error.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    try {
      const embedUrl = `https://streamfree.top/embed/${matchCategory}/${sourceId}`;
      
      // Scrape internally
      const html = await this.embedFetcher.fire(embedUrl);
      if (!html) return [];

      const match = html.match(/const\s+_0x\s*=\s*(\{.*?\});/);
      if (!match) throw new Error("Could not find _0x tokens in StreamFree HTML");

      const tokens = JSON.parse(match[1]);

      // Fetch the stream status to find available qualities
      const statusUrl = `https://streamfree.top/api/stream-status/${sourceId}`;
      let availableQualities = {};
      try {
        const statusRes = await this.proxyFetch(statusUrl, {
           headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' }
        });
        if (statusRes.ok) {
           const statusData = await statusRes.json();
           availableQualities = statusData.qualities || {};
        }
      } catch (e) {
        console.warn(`[StreamFree] Failed to fetch stream status for ${sourceId}`);
      }

      const prefs = ['1080p', '720p', '540p'];
      let bestQuality = null;
      let t = null;

      for (const q of prefs) {
        if (tokens[q] && availableQualities[q]) {
          bestQuality = q;
          t = tokens[q];
          break;
        }
      }
      
      // Fallback
      if (!bestQuality) {
        for (const q of prefs) {
          if (tokens[q]) {
            bestQuality = q;
            t = tokens[q];
            break;
          }
        }
      }

      if (!bestQuality || !t) throw new Error("No suitable stream qualities found");

      // Fetch the stream key to determine if it's on a CDN or origin
      const streamKeyUrl = `https://streamfree.top/get-stream-key/${sourceId}`;
      const streamKeyData = await this.streamKeyFetcher.fire(streamKeyUrl);
      
      let baseUrl = '';
      if (streamKeyData && streamKeyData.is_external && streamKeyData.external_url) {
         baseUrl = streamKeyData.external_url;
      } else {
         const serverName = (streamKeyData && streamKeyData.server_name) ? streamKeyData.server_name : 'origin';
         if (serverName !== 'origin') {
            baseUrl = `https://streamfree.top/live-cdn/${sourceId}${bestQuality}/index.m3u8`;
         } else {
            baseUrl = `https://streamfree.top/live/${sourceId}${bestQuality}/index.m3u8`;
         }
      }
      
      const targetUrl = `${baseUrl}?_t=${t._t}&_e=${t._e}&_n=${t._n}`;

      const referer = 'https://streamfree.top/';
      const { BASE_URL } = require('../config');
      const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(new URL(referer).origin)}`;

      return [new StreamEntity({
        name: 'StreamFree',
        title: `StreamFree (${bestQuality})`,
        url: proxyUrl,
        behaviorHints: {
          notWebReady: true
        },
        resolution: bestQuality
      })];
    } catch (error) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, error.message);
      return [];
    }
  }
}

module.exports = StreamFreeProvider;
