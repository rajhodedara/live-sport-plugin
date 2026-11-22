const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');
const { BASE_URL } = require('../config');

const DEFAULT_FALLBACK_DOMAIN = 'shadow-ran.online';
const DOMAIN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class RoxieStreamsProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'RoxieStreams';
    this.sourceName = 'roxiestreams';
    this.baseUrl = 'https://roxiestreams.su';
    this.sports = ['soccer', 'mlb', 'nba', 'nfl', 'nhl', 'fighting', 'motorsports'];

    this._cachedDomains = null;
    this._cachedDomainsExpiresAt = 0;

    this.fetchCategory = this.circuitBreaker.wrap(`${this.name}_fetchCategory`, async (category) => {
      const url = `${this.baseUrl}/${category}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      };
      const res = await this.proxyFetch(url, { headers, timeoutMs: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    });

    this.fetchStreamPage = this.circuitBreaker.wrap(`${this.name}_fetchStreamPage`, async (path) => {
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      const url = `${this.baseUrl}${cleanPath}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': `${this.baseUrl}/`
      };
      const res = await this.proxyFetch(url, { headers, timeoutMs: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    });

    this.fetchActiveDomain = this.circuitBreaker.wrap(`${this.name}_fetchActiveDomain`, async () => {
      const url = `${this.baseUrl}/domainsz77.txt`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
      };
      const res = await this.proxyFetch(url, { headers, timeoutMs: 10000 });
      if (!res.ok) throw new Error(`HTTP ${res.status} for domainsz77.txt`);
      const body = await res.text();
      const domains = body.trim().split('\n').map(d => d.trim()).filter(Boolean);
      return domains[0] || null;
    });
  }

  _mapCategory(sportKey) {
    if (!sportKey) return 'other';
    const lower = sportKey.toLowerCase();
    const map = {
      'soccer': 'football',
      'nba': 'basketball',
      'nfl': 'american_football',
      'nhl': 'hockey',
      'mlb': 'baseball',
      'fighting': 'mma',
      'ufc': 'mma',
      'boxing': 'mma',
      'motorsports': 'motorsport',
      'f1': 'motorsport',
      'motogp': 'motorsport'
    };
    return map[lower] || 'other';
  }

  async _getActiveDomain() {
    const now = Date.now();
    if (this._cachedDomains && this._cachedDomainsExpiresAt > now) {
      return this._cachedDomains;
    }
    try {
      const domain = await this.fetchActiveDomain.fire();
      if (domain) {
        this._cachedDomains = domain;
        this._cachedDomainsExpiresAt = now + DOMAIN_CACHE_TTL_MS;
        return domain;
      }
    } catch (err) {
      console.warn(`[${this.name}] Failed to fetch domainsz77.txt, using fallback domain:`, err.message);
    }
    return DEFAULT_FALLBACK_DOMAIN;
  }

  _parseListingHtml(html, sportKey) {
    if (!html || typeof html !== 'string') return [];
    const matches = [];
    const category = this._mapCategory(sportKey);

    // Matches standard table rows:
    // <td><a href="/soccer-streams-1">Title</a></td>
    // <td class="event-start-time">Date Time</td>
    const rowRegex = /<tr>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const rowContent = rowMatch[1];
      const linkMatch = rowContent.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      const timeMatch = rowContent.match(/<td\s+[^>]*class=["'][^"']*event-start-time[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);

      if (!linkMatch || !linkMatch[1] || !linkMatch[2]) continue;

      const link = linkMatch[1].trim();
      const rawTitle = linkMatch[2].replace(/<[^>]+>/g, '').trim();
      if (!rawTitle) continue;

      const rawTime = timeMatch ? timeMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      let dateEpoch = 0;
      if (rawTime) {
        const parsed = parseTimezone(rawTime, 'UTC');
        if (parsed && !Number.isNaN(parsed) && parsed > 0) {
          dateEpoch = parsed;
        } else {
          const fallback = Date.parse(rawTime);
          dateEpoch = Number.isNaN(fallback) ? 0 : fallback;
        }
      }

      // Format team names if "vs" exists
      let team1 = null;
      let team2 = null;
      if (rawTitle.includes(' vs ')) {
        const parts = rawTitle.split(' vs ');
        team1 = parts[0].trim();
        team2 = parts[1].trim();
      }

      const slug = link.replace(/^\//, '').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
      // Combine slug and dateEpoch to keep match ID unique across reused timeslots
      const matchId = `roxiestreams_${slug}_${dateEpoch || 'live'}`;

      matches.push(new MatchEntity({
        id: matchId,
        title: rawTitle,
        category,
        date: dateEpoch ? String(dateEpoch) : '',
        timestamp: dateEpoch || 0,
        team1,
        team2,
        sources: [{
          source: this.sourceName,
          id: link,
          name: this.name,
          path: link
        }]
      }));
    }

    return matches;
  }

  _parseStreamPageHtml(html, activeDomain) {
    if (!html || typeof html !== 'string') return [];
    const domain = activeDomain || DEFAULT_FALLBACK_DOMAIN;
    const streams = [];
    const seenUrls = new Set();
    let streamIdx = 1;

    // Extract subdomain if configured on the page
    const subMatch = html.match(/var\s+subdomain\s*=\s*['"]([^'"]+)['"]/i);
    const subdomain = subMatch ? subMatch[1].trim() : 'admin2';

    // 1. Match full direct m3u8 URLs in showPlayer or buttons:
    // e.g. showPlayer('clappr', 'https://bein-esp-xumo.amagi.tv/playlist.m3u8')
    const fullUrlRegex = /showPlayer\(\s*['"][^'"]+['"]\s*,\s*['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]\s*\)/gi;
    let fMatch;
    while ((fMatch = fullUrlRegex.exec(html)) !== null) {
      const streamUrl = fMatch[1];
      if (seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);

      const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(this.baseUrl + '/')}&origin=${encodeURIComponent(this.baseUrl)}&hlsua=${encodeURIComponent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36')}`;

      streams.push(new StreamEntity({
        name: this.name,
        title: `Stream ${streamIdx} (HD)`,
        url: proxyUrl,
        resolution: 'HD',
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'Origin': this.baseUrl,
              'Referer': `${this.baseUrl}/`,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
              'Sec-Fetch-Site': 'cross-site',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Dest': 'empty',
              'Accept': '*/*'
            }
          }
        },
        _source: this.sourceName
      }));
      streamIdx++;
    }

    // 2. Match stream buttons:
    // showPlayer('clappr', getRandomStream('tnt.m3u8', 'admin2'))
    // or getRandomStream('tnt.m3u8')
    const buttonRegex = /getRandomStream\(\s*['"]([^'"]+\.m3u8)['"](?:\s*,\s*['"]([^'"]+)['"])?\s*\)/gi;
    let match;

    while ((match = buttonRegex.exec(html)) !== null) {
      const streamFile = match[1];
      const customSubdomain = match[2] ? match[2].trim() : subdomain;
      const streamUrl = `https://${customSubdomain}.${domain}/${streamFile}`;

      if (seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);

      const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(this.baseUrl + '/')}&origin=${encodeURIComponent(this.baseUrl)}&hlsua=${encodeURIComponent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36')}`;

      streams.push(new StreamEntity({
        name: this.name,
        title: `Stream ${streamIdx} (HD)`,
        url: proxyUrl,
        resolution: 'HD',
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'Origin': this.baseUrl,
              'Referer': `${this.baseUrl}/`,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
              'Sec-Fetch-Site': 'cross-site',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Dest': 'empty',
              'Accept': '*/*'
            }
          }
        },
        _source: this.sourceName
      }));
      streamIdx++;
    }

    // Direct m3u8 fallback if no getRandomStream calls were matched
    if (streams.length === 0) {
      const directM3u8Regex = /['"]([a-zA-Z0-9_-]+\.m3u8)['"]/g;
      let dMatch;
      while ((dMatch = directM3u8Regex.exec(html)) !== null) {
        const streamFile = dMatch[1];
        const streamUrl = `https://${subdomain}.${domain}/${streamFile}`;
        if (!seenUrls.has(streamUrl)) {
          seenUrls.add(streamUrl);
          const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(this.baseUrl + '/')}&origin=${encodeURIComponent(this.baseUrl)}&hlsua=${encodeURIComponent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36')}`;
          streams.push(new StreamEntity({
            name: this.name,
            title: `Stream ${streamIdx} (HD)`,
            url: proxyUrl,
            resolution: 'HD',
            behaviorHints: {
              notWebReady: false,
              proxyHeaders: {
                request: {
                  'Origin': this.baseUrl,
                  'Referer': `${this.baseUrl}/`,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
                  'Sec-Fetch-Site': 'cross-site',
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Dest': 'empty',
                  'Accept': '*/*'
                }
              }
            },
            _source: this.sourceName
          }));
          streamIdx++;
        }
      }
    }

    return streams;
  }

  async getMatches() {
    const allMatches = [];
    for (const sport of this.sports) {
      try {
        const html = await this.fetchCategory.fire(sport);
        const matches = this._parseListingHtml(html, sport);
        if (Array.isArray(matches) && matches.length > 0) {
          allMatches.push(...matches);
        }
      } catch (err) {
        console.warn(`[${this.name}] Failed to fetch category ${sport}:`, err.message);
      }
    }
    return allMatches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src) {
    if (!sourceId) return [];
    try {
      const activeDomain = await this._getActiveDomain();
      const html = await this.fetchStreamPage.fire(sourceId);
      return this._parseStreamPageHtml(html, activeDomain);
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
      return [];
    }
  }
}

module.exports = RoxieStreamsProvider;
