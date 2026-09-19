const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { parseTimezone } = require('../timezone');
const { extract: extractChain } = require('../services/EmbedExtractorChain');
const { getChannelLogo } = require('../services/ChannelLogoService');
const ChannelCountryService = require('../services/ChannelCountryService');
const { BASE_URL } = require('../config');
const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

function extractTokenExpiry(url) {
  if (!url) return 0;
  try {
    const u = new URL(url);
    const e = u.searchParams.get('e') || u.searchParams.get('exp') || u.searchParams.get('expires');
    if (e && /^\d+$/.test(e)) {
      const num = parseInt(e, 10);
      return num < 1e11 ? num * 1000 : num;
    }
  } catch (_) {}
  return 0;
}

class DaddyLiveProvider extends BaseProvider {
  static isEventStream(name) {
    if (!name || typeof name !== 'string') return false;
    const clean = name.trim();
    return /^event\s*[-_]?\s*(sd\s*[-_]?\s*)?stream/i.test(clean) ||
           /^event\s*[-_]?\s*sd\b/i.test(clean) ||
           /\bevent\s*(sd\s*)?stream\b/i.test(clean);
  }

  constructor(opts = {}) {
    super(opts);
    this.name = 'DaddyLive';
    this.baseDomains = ['https://dlstreams.st', 'https://dlive.sx'];
    this.folders = ['stream', 'cast', 'watch', 'player', 'plus', 'casting'];
    this._decoded = new Map(); // sourceId -> { streams, expiresAt }

    this.fetchSchedule = this.circuitBreaker.wrap(`${this.name}_fetchSchedule`, async () => {
      let lastErr = null;

      // Pass 1: Try static JSON schedule across mirror domains (if fresh or in test environment)
      for (const base of this.baseDomains) {
        try {
          const url = `${base}/schedule/schedule-generated.json`;
          const res = await this.proxyFetch(url, {
            headers: {
              'User-Agent': UA,
              'Accept': 'application/json',
              'Referer': `${base}/`
            },
            signal: AbortSignal.timeout(12000)
          });
          if (res && res.ok) {
            const data = typeof res.json === 'function' ? await res.json() : JSON.parse(res.text);
            if (data && typeof data === 'object') {
              const keys = Object.keys(data);
              const hasEvents = keys.some(k => data[k] && Object.keys(data[k]).length > 0);
              if (hasEvents) {
                let isFresh = process.env.NODE_ENV === 'test';
                if (!isFresh) {
                  const now = Date.now();
                  for (const k of keys) {
                    const m = k.match(/(\d+)(?:st|nd|rd|th)\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
                    if (m) {
                      const currentYear = new Date().getUTCFullYear();
                      const year = m[3] ? parseInt(m[3], 10) : currentYear;
                      const parsed = Date.parse(`${m[1]} ${m[2]} ${year} 00:00:00 UTC`);
                      if (!Number.isNaN(parsed) && parsed > 0) {
                        const diffDays = Math.abs(now - parsed) / (1000 * 60 * 60 * 24);
                        if (diffDays <= 2) {
                          isFresh = true;
                          break;
                        }
                      }
                    }
                  }
                }
                if (isFresh) return data;
              }
            }
          }
        } catch (e) {
          lastErr = e;
        }
      }

      // Pass 2: Scrape live homepage HTML (contains current real-time schedule)
      for (const base of this.baseDomains) {
        try {
          const homeRes = await this.proxyFetch(`${base}/`, {
            headers: {
              'User-Agent': UA,
              'Referer': `${base}/`
            },
            signal: AbortSignal.timeout(12000)
          });
          if (homeRes && homeRes.ok) {
            const homeHtml = typeof homeRes.text === 'function' ? await homeRes.text() : homeRes.text;
            const parsed = this.parseScheduleHtml(homeHtml);
            if (parsed) return parsed;
          }
        } catch (e) {
          lastErr = e;
        }
      }

      throw lastErr || new Error('All DaddyLive schedule endpoints failed');
    });

    this.fetchChannels = this.circuitBreaker.wrap(`${this.name}_fetchChannels`, async () => {
      let lastErr = null;
      for (const base of this.baseDomains) {
        try {
          const url = `${base}/24-7-channels.php`;
          const res = await this.proxyFetch(url, {
            headers: {
              'User-Agent': UA,
              'Referer': `${base}/`
            },
            signal: AbortSignal.timeout(15000)
          });
          if (res.ok) {
            if (typeof res.text === 'function') {
              return await res.text();
            } else if (typeof res.text === 'string') {
              return res.text;
            }
          }
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('All DaddyLive 24-7 channels endpoints failed');
    });
  }

  clearCache(sourceId) {
    if (sourceId) {
      this._decoded.delete(String(sourceId));
    } else {
      this._decoded.clear();
    }
  }

  /**
   * Decodes DaddyLive / DLHD obfuscated _econfig payload.
   *
   * Algorithm:
   * 1. Base64 decode raw string.
   * 2. Split decoded string into 4 equal segments (ceil(len / 4)).
   * 3. For each segment, remove the decoy canary char at index 3 (slice(0, 3) + slice(4)).
   * 4. Base64 decode each segment into reordered index [2, 0, 3, 1].
   * 5. Join reordered segments and Base64 decode to JSON object.
   */
  decodeEconfig(rawEconfig) {
    if (!rawEconfig || typeof rawEconfig !== 'string') return null;
    try {
      const order = [2, 0, 3, 1];
      const partsCount = 4;
      const decodedB64 = Buffer.from(rawEconfig, 'base64').toString('utf-8');
      const len = decodedB64.length;
      if (len < partsCount) return null;

      const partLen = Math.ceil(len / partsCount);
      const parts = [];
      let offset = 0;
      for (let i = 0; i < partsCount; i++) {
        parts.push(decodedB64.substr(offset, partLen));
        offset += partLen;
      }

      const orderedParts = [];
      for (let i = 0; i < order.length; i++) {
        let str = String(parts[i]);
        str = str.slice(0, 3) + str.slice(4);
        orderedParts[order[i]] = Buffer.from(str, 'base64').toString('utf-8');
      }

      const combined = orderedParts.join('');
      const finalJsonStr = Buffer.from(combined, 'base64').toString('utf-8');
      return JSON.parse(finalJsonStr);
    } catch (_) {
      return null;
    }
  }

  /**
   * Parses live schedule directly from DaddyLive homepage HTML.
   * Extracts real daily fixtures, leagues, teams, times, and broadcast channel IDs.
   */
  parseScheduleHtml(html) {
    if (!html || typeof html !== 'string') return null;
    try {
      const $ = cheerio.load(html);
      const dayHeader = $('.schedule__dayTitle').first().text().trim();
      if (!dayHeader) return null;

      const result = { [dayHeader]: {} };

      $('.schedule__category').each((_, catElem) => {
        const rawCat = $(catElem).find('.card__meta').first().text().trim();
        if (!rawCat || rawCat.toLowerCase().includes('big brother')) return;
        const cleanCat = decodeHtmlEntities(rawCat)
          .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
          .replace(/\s+/g, ' ')
          .trim();

        const events = [];
        $(catElem).find('.schedule__event').each((_, evElem) => {
          const time = $(evElem).find('.schedule__time').text().trim();
          const rawTitle = $(evElem).find('.schedule__eventTitle').text().trim();
          if (!rawTitle) return;

          const channels = [];
          $(evElem).find('.schedule__channels a').each((_, a) => {
            const idMatch = ($(a).attr('href') || '').match(/id=(\d+)/);
            if (idMatch && idMatch[1] !== '00') {
              const chName = $(a).text().trim() || $(a).attr('title') || `Channel ${idMatch[1]}`;
              if (DaddyLiveProvider.isEventStream(chName)) return;
              channels.push({
                channel_id: idMatch[1],
                channel_name: chName
              });
            }
          });

          if (channels.length > 0) {
            events.push({
              time,
              event: decodeHtmlEntities(rawTitle)
                .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
                .replace(/\s+/g, ' ')
                .trim(),
              channels
            });
          }
        });

        if (events.length > 0) {
          result[dayHeader][cleanCat] = events;
        }
      });

      return Object.keys(result[dayHeader]).length > 0 ? result : null;
    } catch (_) {
      return null;
    }
  }

  async getMatches() {
    const matches = [];
    try {
      const data = await this.fetchSchedule.fire();
      if (!data || typeof data !== 'object') return matches;

      const now = Date.now();

      for (const dayHeader of Object.keys(data)) {
        // Parse date header (e.g. "Friday 18th Sep 2026 - Schedule Time UK GMT")
        const dateMatch = dayHeader.match(/(\d+)(?:st|nd|rd|th)\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
        const currentYear = new Date().getUTCFullYear();
        const year = dateMatch && dateMatch[3] ? parseInt(dateMatch[3], 10) : currentYear;
        const dayStr = dateMatch ? `${dateMatch[1]} ${dateMatch[2]} ${year}` : '';

        const categories = data[dayHeader];
        if (!categories || typeof categories !== 'object') continue;

        for (const rawCat of Object.keys(categories)) {
          const events = categories[rawCat];
          if (!Array.isArray(events)) continue;

          // Strip HTML, emojis, and decode entities from category
          const cleanCat = decodeHtmlEntities(rawCat.replace(/<[^>]+>/g, ''))
            .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
          let normalizedCategory = this.normalizeCategory(cleanCat);

          for (const ev of events) {
            if (!ev || !ev.event) continue;

            // Collect channels
            const channels = [...(ev.channels || []), ...(ev.channels2 || [])];
            const sources = [];
            const seenCh = new Set();
            for (const ch of channels) {
              if (ch && ch.channel_id) {
                const chId = String(ch.channel_id).trim();
                if (!seenCh.has(chId)) {
                  seenCh.add(chId);
                  const chName = decodeHtmlEntities(ch.channel_name || '').trim();
                  if (DaddyLiveProvider.isEventStream(chName)) continue;
                  const countryInfo = ChannelCountryService.detectChannelCountry(chName);
                  sources.push({
                    source: 'daddylive',
                    id: chId,
                    channelName: chName || `Channel ${chId}`,
                    country: countryInfo ? countryInfo.name : undefined,
                    countryName: countryInfo ? countryInfo.country : undefined,
                    countryFlag: countryInfo ? countryInfo.flag : undefined,
                    language: countryInfo ? countryInfo.language : undefined
                  });
                }
              }
            }

            // Skip events with no available stream channels
            if (sources.length === 0) continue;

            // Split "League : Team1 vs Team2" and decode entities
            const rawEvent = decodeHtmlEntities(ev.event)
              .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, '')
              .replace(/\s+/g, ' ')
              .trim();
            let league = '';
            let title = rawEvent;
            const colonIdx = rawEvent.indexOf(' : ');
            if (colonIdx !== -1) {
              league = rawEvent.slice(0, colonIdx).trim();
              title = rawEvent.slice(colonIdx + 3).trim();
            }

            // Refine category if generic or if league/title indicates college/ncaa
            let eventCategory = normalizedCategory;
            const fullContext = `${cleanCat} ${league} ${title}`.toLowerCase();
            if (fullContext.includes('college') || fullContext.includes('ncaa')) {
              eventCategory = 'college';
            } else if (eventCategory === 'other') {
              eventCategory = this.normalizeCategory(`${cleanCat} ${league} ${title}`);
            }

            // Filter out well-known stale dummy fixtures left on DaddyLive's test channels
            const titleCheck = `${league} ${title}`.toLowerCase();
            if (titleCheck.includes('kings xi punjab')) continue;
            const curMonth = new Date().getUTCMonth();
            if ((titleCheck.includes('indian premier league') || titleCheck.includes('ipl')) && (curMonth > 5 && curMonth < 11)) continue;

            // Parse kickoff timestamp (UK GMT / UTC)
            let matchTime = null;
            // If category is "Upcoming Events" or raw title specifies an explicit future date, extract it
            if (cleanCat.toLowerCase().includes('upcoming') || rawEvent.includes(' 202')) {
              const titleDateMatch = rawEvent.match(/(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{4}))?/i);
              if (titleDateMatch) {
                const year = titleDateMatch[3] ? parseInt(titleDateMatch[3], 10) : currentYear;
                const timePart = ev.time ? `${ev.time}:00 UTC` : '00:00:00 UTC';
                const parsed = Date.parse(`${titleDateMatch[1]} ${titleDateMatch[2]} ${year} ${timePart}`);
                if (!Number.isNaN(parsed) && parsed > 0) {
                  matchTime = parsed;
                }
              }
            }

            if (!matchTime && dayStr && ev.time) {
              const dateStr = `${dayStr} ${ev.time}:00 UTC`;
              const parsed = Date.parse(dateStr);
              if (!Number.isNaN(parsed) && parsed > 0) {
                // Times before 06:00 on a daily schedule are late-night events that rolled over midnight
                if (ev.time < '06:00') {
                  matchTime = parsed + (24 * 3600 * 1000);
                } else {
                  matchTime = parsed;
                }
              }
            }
            if (!matchTime && ev.time) {
              const parsed = parseTimezone(ev.time, 'UTC');
              if (parsed && ev.time < '06:00') {
                matchTime = parsed + (24 * 3600 * 1000);
              } else {
                matchTime = parsed;
              }
            }
            if (!matchTime) {
              continue; // Do not guess unparseable times
            }

            // Duration check to omit finished matches
            const DADDYLIVE_DURATIONS_MS = {
              cricket: 8 * 60 * 60 * 1000,
              mma: 6 * 60 * 60 * 1000,
              fighting: 6 * 60 * 60 * 1000,
              boxing: 5 * 60 * 60 * 1000,
              motorsport: 4 * 60 * 60 * 1000,
              american_football: 4 * 60 * 60 * 1000,
              baseball: 3.5 * 60 * 60 * 1000,
              basketball: 3 * 60 * 60 * 1000,
              tennis: 4 * 60 * 60 * 1000,
              golf: 6 * 60 * 60 * 1000,
              football: 2.5 * 60 * 60 * 1000,
              rugby: 2.5 * 60 * 60 * 1000,
              hockey: 3 * 60 * 60 * 1000,
              darts: 4 * 60 * 60 * 1000
            };
            const maxDuration = DADDYLIVE_DURATIONS_MS[eventCategory] || (3 * 60 * 60 * 1000);

            // If the match has fully ended (past kickoff + maxDuration), skip it
            if (now > matchTime + maxDuration) {
              continue;
            }

            // Let addon core determine live status via isMatchLive clock evaluation
            const status = now < matchTime ? 'upcoming' : '';

            // Extract team1 and team2
            let team1 = null;
            let team2 = null;
            const parts = title.split(/\s(?:vs?\.?|@|[-–—])\s/i);
            if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
              team1 = { name: parts[0].trim() };
              team2 = { name: parts[1].trim() };
            }

            const firstId = sources[0].id;
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');

            let eventLogo = null;
            for (const s of sources) {
              if (s.channelName) {
                const l = getChannelLogo(s.channelName);
                if (l) { eventLogo = l; break; }
              }
            }

            matches.push(new MatchEntity({
              id: `dlv_${firstId}_${slug}`,
              title,
              category: eventCategory,
              status,
              date: String(matchTime),
              league,
              team1,
              team2,
              logo: eventLogo || undefined,
              thumbnail_url: eventLogo || undefined,
              sources
            }));
          }
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }

    // Ingest 24/7 Sports Networks & TV Channels (e.g. Fox Sports 1 USA, ESPN, Sky Sports)
    try {
      const channelsHtml = await this.fetchChannels.fire();
      if (channelsHtml && typeof channelsHtml === 'string') {
        const re = /href=["'](?:\/)?watch\.php\?id=(\d+)["'][\s\S]*?<div class="card__title">([^<]+)<\/div>/gi;
        const matches247 = [...channelsHtml.matchAll(re)];
        const seen247 = new Set();

        for (const m of matches247) {
          const chId = m[1].trim();
          const rawName = decodeHtmlEntities(m[2]).trim();
          if (!chId || !rawName || seen247.has(chId)) continue;
          if (rawName.startsWith('18+') || rawName.includes('18+')) continue;
          seen247.add(chId);

          const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          const logoUrl = getChannelLogo(rawName);

          matches.push(new MatchEntity({
            id: `dlv_ch_${chId}_${slug}`,
            title: rawName,
            baseTitle: rawName,
            category: 'networks',
            date: '0',
            popular: '1',
            league: 'Live TV',
            logo: logoUrl || undefined,
            thumbnail_url: logoUrl || undefined,
            sources: [{
              source: 'daddylive',
              id: chId,
              channelName: rawName
            }]
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get 24-7 channels:`, err.message);
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const sId = String(sourceId);
    if (src && (src.forceRefresh || src.skipCache)) {
      this._decoded.delete(sId);
    }

    const cached = this._decoded.get(sId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.streams;
    }

    const streams = [];
    const channelName = decodeHtmlEntities(src.channelName || '');
    let foundDirect = false;

    // Probe folders across mirror domains
    for (const base of this.baseDomains) {
      if (foundDirect) break;

      for (const folder of this.folders) {
        if (foundDirect) break;

        const playerUrl = `${base}/${folder}/stream-${sourceId}.php`;
        try {
          const res = await this.proxyFetch(playerUrl, {
            headers: {
              'User-Agent': UA,
              'Referer': `${base}/`,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: AbortSignal.timeout(6000)
          });

          if (!res.ok) continue;

          const html = await res.text();
          // Match iframe src (supports quoted and unquoted src)
          const iframeMatch = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
          if (!iframeMatch || !iframeMatch[1]) continue;

          let iframeUrl = iframeMatch[1];
          if (iframeUrl.startsWith('//')) {
            iframeUrl = 'https:' + iframeUrl;
          } else if (iframeUrl.startsWith('/')) {
            iframeUrl = new URL(iframeUrl, playerUrl).toString();
          }

          let embedOrigin = '';
          try {
            embedOrigin = new URL(iframeUrl).origin;
          } catch (_) {
            embedOrigin = base;
          }
          const embedReferer = `${embedOrigin}/`;

          // Fetch the embed page
          const embedRes = await this.proxyFetch(iframeUrl, {
            headers: {
              'User-Agent': UA,
              'Referer': playerUrl,
              'Origin': base,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            signal: AbortSignal.timeout(6000)
          });

          if (!embedRes.ok) continue;

          const embedHtml = await embedRes.text();
          let m3u8Url = null;

          // 1. Check for DaddyLive _econfig
          const econfigMatch = embedHtml.match(/_econfig\s*=\s*['"]([^'"]+)['"]/);
          if (econfigMatch && econfigMatch[1]) {
            const conf = this.decodeEconfig(econfigMatch[1]);
            if (conf) {
              m3u8Url = conf.stream_url || conf.stream_url_nop2p || null;
            }
          }

          // 2. Check EmbedExtractorChain
          if (!m3u8Url) {
            const chainResult = extractChain(embedHtml, 'daddylive');
            if (chainResult && chainResult.url) {
              m3u8Url = chainResult.url;
            }
          }

          // 3. Plain regex for direct HLS playlist
          if (!m3u8Url) {
            const directMatch = embedHtml.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
            if (directMatch && directMatch[1]) {
              m3u8Url = directMatch[1];
            }
          }

          // 4. Nested iframe fallback (1 level)
          if (!m3u8Url) {
            const nestedIframeMatch = embedHtml.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
            if (nestedIframeMatch && nestedIframeMatch[1]) {
              let nestedUrl = nestedIframeMatch[1];
              if (nestedUrl.startsWith('//')) nestedUrl = 'https:' + nestedUrl;
              else if (nestedUrl.startsWith('/')) nestedUrl = new URL(nestedUrl, iframeUrl).toString();

              try {
                const nestedRes = await this.proxyFetch(nestedUrl, {
                  headers: { 'User-Agent': UA, 'Referer': iframeUrl },
                  signal: AbortSignal.timeout(5000)
                });
                if (nestedRes.ok) {
                  const nestedHtml = await nestedRes.text();
                  const nestedEconfig = nestedHtml.match(/_econfig\s*=\s*['"]([^'"]+)['"]/);
                  if (nestedEconfig && nestedEconfig[1]) {
                    const conf = this.decodeEconfig(nestedEconfig[1]);
                    if (conf) m3u8Url = conf.stream_url || conf.stream_url_nop2p || null;
                  }
                  if (!m3u8Url) {
                    const chainRes = extractChain(nestedHtml, 'daddylive');
                    if (chainRes && chainRes.url) m3u8Url = chainRes.url;
                  }
                }
              } catch (_) {}
            }
          }

          if (m3u8Url) {
            const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(embedReferer)}&origin=${encodeURIComponent(embedOrigin)}`;
            const label = channelName ? `DaddyLive (${channelName})` : `DaddyLive Stream ${sourceId}`;

            streams.push(new StreamEntity({
              name: 'DaddyLive',
              title: label,
              url: proxyUrl,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: {
                  request: {
                    'Referer': embedReferer,
                    'Origin': embedOrigin,
                    'User-Agent': UA
                  }
                }
              },
              resolution: 'HD'
            }));

            foundDirect = true;
            break;
          }
        } catch (_) {
          // Continue trying next folder/domain
        }
      }
    }

    // Web player fallback if no direct stream was decrypted
    if (streams.length === 0) {
      const fallbackUrl = `https://dlive.sx/stream/stream-${sourceId}.php`;
      const label = channelName ? `DaddyLive (${channelName}) (Web Player)` : `DaddyLive Stream ${sourceId} (Web Player)`;
      streams.push(new StreamEntity({
        name: 'DaddyLive',
        title: label,
        externalUrl: `/watch?url=${encodeURIComponent(fallbackUrl)}&title=${encodeURIComponent(matchTitle || 'DaddyLive Stream')}`,
        resolution: 'HD'
      }));
    }

    // Cache streams with TTL bounded by token expiry or default 5 minutes
    const firstDirect = streams.find(s => s.url && s.url.includes('/api/manifest?'));
    let tokenExp = 0;
    if (firstDirect) {
      try {
        const uObj = new URL('http://localhost' + firstDirect.url);
        tokenExp = extractTokenExpiry(uObj.searchParams.get('url'));
      } catch (_) {}
    }
    const defaultTtl = 5 * 60 * 1000;
    const expiresAt = tokenExp && tokenExp > Date.now()
      ? Math.min(tokenExp - 60000, Date.now() + defaultTtl)
      : Date.now() + defaultTtl;

    if (this._decoded.size >= 500) {
      this._decoded.delete(this._decoded.keys().next().value);
    }
    this._decoded.set(sId, {
      streams,
      expiresAt
    });

    return streams;
  }
}

module.exports = DaddyLiveProvider;
