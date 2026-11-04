'use strict';
const { fetchUndici: fetch } = require('../../services/ProviderOutbound');

const SkTechCrypto = require('./SkTechCrypto');
const SkTechEmbedExtractor = require('./SkTechEmbedExtractor');
const SkTechMatchResolver = require('./SkTechMatchResolver');

const BASE_API_URL = 'https://dk01-64n.pages.dev/';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Precompiled Schwartzian Regexes
const VS_REGEX = /\b(?:vs|v)\b/i;
const VERSUS_REGEX = /\bversus\b/i;
const TEST_DEMO_REGEX = /^test\b|^demo\b|^placeholder\b/i;
const USA_SPORTS_REGEX = /sport|espn|btn|ncaa|peacock|ppv|nhl|ahl|mlb|nba|nfl|mls|fight/i;
const USA_NETWORKS_REGEX = /network|premium|news/i;

class SkTechChannelResolver {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_API_URL;
    this._customCache = new Map();
    this._customCacheTime = new Map();
    this._m3uCache = new Map();
    this._m3uCacheTime = new Map();
    this._channelsCache = null;
    this._channelsCacheTime = 0;
  }

  clearCache() {
    this._customCache.clear();
    this._customCacheTime.clear();
    this._m3uCache.clear();
    this._m3uCacheTime.clear();
    this._channelsCache = null;
    this._channelsCacheTime = 0;
  }

  /**
   * Ingest and decrypt all 24/7 TV channels & categories from `categories.txt`
   * Maps everything cleanly under category 'networks' and kickoff '0'
   * Unpacks multi-tier nested bouquets:
   * - Custom multi-channel groups (SPORTS WORLD, Hindi, Tamil, Telugu, Pakistan, Movies, News)
   * - Encrypted dynamic M3U playlists (BIG BOSS -> Cricket + Reality)
   * - Multi-channel M3U bouquets (SUN NXT with ClearKey, CRIC HD, USA/UK TV)
   *
   * @param {Object} [options={}]
   * @param {boolean} [options.forceRefresh=false]
   * @returns {Promise<Array<Object>>} Normalized 24/7 channel items
   */
  async fetchChannels(options = {}) {
    const now = Date.now();
    if (!options.forceRefresh && this._channelsCache && (now - this._channelsCacheTime < CACHE_TTL_MS)) {
      return this._channelsCache;
    }

    let rawCategories = [];
    try {
      const url = `${this.baseUrl}categories.txt`;
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA },
        signal: AbortSignal.timeout(6000)
      });

      if (!res.ok) return [];

      const rawCiphertext = (await res.text()).trim();
      const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
      rawCategories = JSON.parse(decryptedJson);
    } catch (_) {
      return [];
    }

    // Parallelize bouquet ingestion using bounded Promise.allSettled
    const bouquetTasks = rawCategories.map(async (entry, i) => {
      const item = typeof entry.cat === 'string' ? JSON.parse(entry.cat) : entry.cat;
      if (!item || item.visible === false) return [];

      const name = (item.name || `Channel ${i + 1}`).trim();
      if (/^test$/i.test(name) || /^demo$/i.test(name)) return [];
      if (/jtv|jiostar|play\s*tata|vzy/i.test(name)) return [];
      const logo = item.logo || '';
      const type = item.type || 'm3u';
      const api = item.api || '';

      // Skip public iptv-org country bouquets and dead FAST servers to eliminate clutter and timeouts
      if (api.includes('iptv-org.github.io') || api.includes('apsattv.com')) return [];

      // Skip known dead/dummy worker endpoints that host zero playable streams
      if (api.includes('thanks-to-veer.saqlainhaider8198.workers.dev') ||
          api.includes('dehkho24h.alpha-circuit.workers.dev') ||
          api.includes('cloud-hatchh.workers.dev') ||
          api.includes('data-vortex.workers.dev') ||
          api.includes('dishtv.m3u')) return [];

      const categoryChannels = [];

      // ────────────────────────────────────────────────────────────────────────
      // Tier 1: Custom channel group definitions (channels/<id>.txt)
      // ────────────────────────────────────────────────────────────────────────
      if (type === 'custom' && api) {
        try {
          const subChannels = await this.fetchCustomChannelGroup(api);
          if (subChannels && subChannels.length > 0) {
            const isSportsGroup = /sport|raw|smackdown|wwe/i.test(name) || api.includes('U1BPUlRTIFdPUkxE');
            const groupTag = isSportsGroup ? 'Sports Channels' : name;

            for (let j = 0; j < subChannels.length; j++) {
              const sub = subChannels[j];
              const subTitle = (sub.title || '').trim();
              if (TEST_DEMO_REGEX.test(subTitle)) continue;
              if (/test/i.test(sub.links || '')) continue;
              if (VS_REGEX.test(subTitle) && !VERSUS_REGEX.test(subTitle)) continue;
              categoryChannels.push({
                id: `sktech_ch_cust_${i}_${j}`,
                title: sub.title || `${name} - ${j + 1}`,
                category: 'networks',
                kickoff: 0,
                type: 'pro',
                logo: sub.logo || logo,
                poster: sub.logo || logo,
                links: sub.links,
                group: groupTag
              });
            }
          }
        } catch (_) {}
      }
      // ────────────────────────────────────────────────────────────────────────
      // Tier 2: M3U Playlists (Direct feeds, multi-channel bouquets, encrypted workers)
      // ────────────────────────────────────────────────────────────────────────
      else if (type === 'm3u' && api) {
        try {
          let defaultGroup = name;
          if (/sun\s*nxt/i.test(name) || api.includes('sunxt.m3u')) defaultGroup = 'Sun NXT';
          else if (/cric\s*hd/i.test(name) || api.includes('CricketLive')) defaultGroup = 'Cricket';
          else if (/sports\s*event|fc\s*live/i.test(name)) defaultGroup = 'Sports Channels';
          else if (/boss/i.test(name)) defaultGroup = 'Big Boss';
          else if (/usa\s*live|usa\s*tv|prime\s*usa/i.test(name)) defaultGroup = 'USA TV';
          else if (/sony|sonyliv/i.test(name) || api.includes('nony')) defaultGroup = 'Sony LIV';

          const subChannels = await this.fetchM3uBouquet(api, defaultGroup);
          if (subChannels && subChannels.length > 0) {
            let selectedChannels = subChannels;
            if (defaultGroup === 'USA TV') {
              // Prioritize Sports, Networks, and News over obscure local channels
              const sports = [];
              const networks = [];
              const otherClean = [];
              for (const sub of subChannels) {
                const grp = (sub.group || '').toLowerCase();
                if (USA_SPORTS_REGEX.test(grp)) {
                  sports.push(sub);
                } else if (USA_NETWORKS_REGEX.test(grp)) {
                  networks.push(sub);
                } else {
                  otherClean.push(sub);
                }
              }
              selectedChannels = [...sports, ...networks, ...otherClean].slice(0, 350);
            } else {
              selectedChannels = subChannels.slice(0, 250);
            }

            for (let j = 0; j < selectedChannels.length; j++) {
              const sub = selectedChannels[j];
              if (sub.drmScheme || (sub.url && sub.url.includes('.mpd'))) continue;
              if (VS_REGEX.test(sub.title || '') && !VERSUS_REGEX.test(sub.title || '')) continue;
              let channelGroup = sub.group || defaultGroup;
              if (defaultGroup === 'USA TV') {
                if (USA_SPORTS_REGEX.test(sub.group || '')) {
                  channelGroup = 'Sports Channels';
                } else {
                  channelGroup = 'USA TV';
                }
              }

              categoryChannels.push({
                id: `sktech_ch_m3u_${i}_${j}`,
                title: sub.title,
                category: 'networks',
                kickoff: 0,
                type: 'direct_m3u',
                logo: sub.logo || logo,
                poster: sub.logo || logo,
                url: sub.url,
                headers: sub.headers,
                drmScheme: sub.drmScheme,
                drmLicense: sub.drmLicense,
                group: channelGroup,
                language: sub.language
              });
            }
          }
        } catch (_) {}
      }

      return categoryChannels;
    });

    const results = await Promise.allSettled(bouquetTasks);
    const channels = [];
    for (const res of results) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        channels.push(...res.value);
      }
    }

    this._channelsCache = channels;
    this._channelsCacheTime = now;
    return channels;
  }

  /**
   * Resolves and parses a multi-channel M3U playlist with 5-minute in-memory caching
   * Automatically decrypts encrypted worker responses (like BIG BOSS / [rts])
   *
   * @param {string} rawApi - M3U URL with possible pipe delimiter or worker token
   * @param {string} defaultGroup - Fallback group title
   * @returns {Promise<Array<Object>>} Constituent channel objects
   */
  async fetchM3uBouquet(rawApi, defaultGroup = 'Live TV') {
    if (!rawApi) return [];

    const now = Date.now();
    const lastTime = this._m3uCacheTime.get(rawApi) || 0;
    if (this._m3uCache.has(rawApi) && now - lastTime < CACHE_TTL_MS) {
      return this._m3uCache.get(rawApi);
    }

    const parsed = SkTechEmbedExtractor.parseDelimited(rawApi);
    if (!parsed.url) return [];

    try {
      const res = await fetch(parsed.url, {
        headers: {
          'User-Agent': parsed.headers['User-Agent'] || DEFAULT_UA,
          'Accept': '*/*',
          ...parsed.headers
        },
        signal: AbortSignal.timeout(5000)
      });

      if (!res.ok) return [];

      const rawText = (await res.text()).trim();
      // If response is encrypted (like BIG BOSS), decrypt via reversed Dalvik algorithm
      const m3uContent = SkTechCrypto.decryptM3u(rawText);

      const items = this.parseM3uBouquet(m3uContent, defaultGroup, parsed.headers);
      this._m3uCache.set(rawApi, items);
      this._m3uCacheTime.set(rawApi, now);
      return items;
    } catch (_) {
      return [];
    }
  }

  /**
   * Parses an M3U playlist into discrete channel objects
   * Fully supports EXTINF tags, group-title, tvg-logo, #KODIPROP clearkey, and EXTVLCOPT headers
   *
   * @param {string} m3uText
   * @param {string} defaultGroup
   * @param {Object} defaultHeaders
   * @returns {Array<Object>}
   */
  parseM3uBouquet(m3uText, defaultGroup = 'Live TV', defaultHeaders = {}) {
    if (!m3uText || typeof m3uText !== 'string') return [];

    const channels = [];
    const lines = m3uText.split(/\r?\n/);

    let currentTitle = '';
    let currentLogo = '';
    let currentGroup = defaultGroup;
    let currentLang = '';
    let currentDrmScheme = null;
    let currentDrmLicense = null;
    let currentHeaders = { ...defaultHeaders };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        const commaIdx = line.indexOf(',');
        if (commaIdx !== -1) {
          currentTitle = line.slice(commaIdx + 1).trim();
        }
        const metaPortion = commaIdx !== -1 ? line.slice(0, commaIdx) : line;
        const attrRe = /\b(group-title|tvg-logo|tvg-language)="([^"]*)"/gi;
        let match;
        while ((match = attrRe.exec(metaPortion)) !== null) {
          const key = match[1].toLowerCase();
          const val = match[2];
          if (key === 'group-title' && val.trim()) currentGroup = val.trim();
          else if (key === 'tvg-logo' && val.trim()) currentLogo = val.trim();
          else if (key === 'tvg-language' && val.trim()) currentLang = val.trim();
        }
      } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) {
        const val = line.split('=')[1].trim().toLowerCase();
        if (val.includes('clearkey')) currentDrmScheme = 'clearkey';
        else if (val.includes('widevine')) currentDrmScheme = 'widevine';
      } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
        currentDrmLicense = line.split('=')[1].trim();
      } else if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
        currentHeaders['User-Agent'] = line.slice(line.indexOf('=') + 1).trim();
      } else if (line.startsWith('#EXTVLCOPT:http-referer=') || line.startsWith('#EXTVLCOPT:http-referrer=')) {
        currentHeaders['Referer'] = line.slice(line.indexOf('=') + 1).trim();
      } else if (line.startsWith('#EXTVLCOPT:http-origin=')) {
        currentHeaders['Origin'] = line.slice(line.indexOf('=') + 1).trim();
      } else if (line.startsWith('#EXTHTTP:')) {
        try {
          const rawJson = line.slice(9).trim();
          const parsed = JSON.parse(rawJson);
          Object.assign(currentHeaders, parsed);
        } catch (_) {}
      } else if (line.startsWith('http://') || line.startsWith('https://')) {
        const parsed = SkTechEmbedExtractor.parseDelimited(line, { defaultUserAgent: false });
        const streamUrl = parsed.url;
        const mergedHeaders = { 'User-Agent': DEFAULT_UA, ...currentHeaders, ...parsed.headers };

        if (streamUrl) {
          const t = currentTitle || '';
          const g = currentGroup || '';
          const isTestOrDemo = /^test\b|^demo\b|^placeholder\b|^sample\b|^trial\b/i.test(t) ||
                               /streamtest|livetest|\/test\.m3u8|\/test\/|test_pic|test_trojka|test_infokanal|test_cgtn/i.test(streamUrl);
          const isRadio = g.startsWith('Radio_') || /\b(radio|fm|podcast)\b/i.test(t) || /\bradio\b/i.test(g);
          const isReligious = /relig|church|jesus|gospel|catholic|christ|bible|islam|quran|faith/i.test(g) ||
                              /relig|church|jesus|gospel|catholic|christ|bible|islam|quran|faith/i.test(t);
          const isShopping = /shopping|qvc|hsn/i.test(g) || /qvc|hsn/i.test(t);
          const isOfflineOrGeo = /\[geo-blocked\]|\[not 24\/7\]|\(offline\)|\[offline\]|\(unavailable\)|\[dead\]|\[off air\]|\[not working\]|\[testing\]/i.test(t);
          const isPlaceholder = /download sk tech|placeholder|^upcoming$/i.test(t);
          const isDeadHost = /aalmaruf1702|bbc-hls-live\.akamaized\.net|vod\.hbomax\.com|hoast-plm\.shop/i.test(streamUrl)
            || /pluto\.tv/i.test(streamUrl)             // Nukes all 740 "That's a wrap" slates
            || /kstv\.us/i.test(streamUrl)              // Nukes 717 expired 401 accounts
            || /vocotv\.pro/i.test(streamUrl)           // Nukes 574 offline connection-refused servers
            || /leadcool\.xyz/i.test(streamUrl)         // Nukes 221 dead connection-refused Xtream servers (including NFL team channels)
            || /scalecdn\.co/i.test(streamUrl)          // Nukes 365 expired 0-byte accounts (including MLB team channels)
            || /moveonjoy\.com/i.test(streamUrl)        // Nukes 107 connection hangup servers
            || /dfqz\.cc|supersonictv|1tv41\.icu|nonamevos/i.test(streamUrl)
            || /frequency\.stream/i.test(streamUrl)     // Nukes dead FAST frequency streams
            || /cord-cutter\.net|raccoon\.bz/i.test(streamUrl)
            || /t\.me|telegram/i.test(streamUrl)        // Nukes fake Telegram promo cards
            || /d35j504z0x2vu2\.cloudfront\.net/i.test(streamUrl)   // Nukes 131 dead DNS channels
            || /hls.*\.stb\.md/i.test(streamUrl)                    // Nukes 96 expired 403 token channels
            || /tapmadlive\.akamaized\.net/i.test(streamUrl)        // Nukes 36 expired 403 channels
            || /3catdirectes\.cat/i.test(streamUrl)                 // Nukes 29 expired 403 Catalan channels
            || /livetv-fa\.tubi\.video|apollo\.production-public\.tubi\.io/i.test(streamUrl) // Nukes 27 dead DNS Tubi channels
            || /d2gvyg6lvauoko\.cloudfront\.net/i.test(streamUrl)   // Nukes 16 dead 403 CloudFront channels
            || /content.*\.uplynk\.com/i.test(streamUrl)            // Nukes 14 dead 404 Uplynk endpoints
            || /d1g8wgjurz8via\.cloudfront\.net/i.test(streamUrl)   // Nukes 13 dead timeout CloudFront channels
            || /stream-us-east-1\.getpublica\.com/i.test(streamUrl) // Nukes 12 HTTP 400 endpoints
            || /mdc\.ott\.alticeusa\.net/i.test(streamUrl)          // Nukes 12 dead Altice timeout channels
            || /liveingesta318\.cdnmedia\.tv/i.test(streamUrl)      // Nukes 10 HTTP 403 channels
            || /.*\.cdn\.runn\.tv|playout\.runn\.tv/i.test(streamUrl) // Nukes 17 dead Runn TV channels
            || /fast-channels\.atresmedia\.com/i.test(streamUrl)    // Nukes 7 HTTP 492 blocked channels
            || /streamer\.zapitv\.com|energeek\.cl/i.test(streamUrl) // Nukes 12 HTTP 403 channels
            || /token=expired/i.test(streamUrl);

          if (!isTestOrDemo && !isRadio && !isReligious && !isShopping && !isOfflineOrGeo && !isPlaceholder && !isDeadHost) {
            channels.push({
              title: currentTitle || `Channel ${channels.length + 1}`,
              logo: currentLogo,
              group: currentGroup,
              language: currentLang,
              url: streamUrl,
              headers: mergedHeaders,
              drmScheme: currentDrmScheme || parsed.drmScheme,
              drmLicense: currentDrmLicense || parsed.drmLicense
            });
          }
        }

        // Reset per-channel state
        currentTitle = '';
        currentLogo = '';
        currentGroup = defaultGroup;
        currentLang = '';
        currentDrmScheme = null;
        currentDrmLicense = null;
        currentHeaders = { ...defaultHeaders };
      }
    }

    return channels;
  }

  /**
   * Resolves a custom channel group into its constituent stream items
   *
   * @param {string} customApiPath - e.g. `channels/RVBJQyBPTjE3Njg1MDQ2NzY4MTI.txt`
   * @returns {Promise<Array<Object>>} Channel items with individual stream links
   */
  async fetchCustomChannelGroup(customApiPath) {
    if (!customApiPath) return [];

    const now = Date.now();
    const lastTime = this._customCacheTime.get(customApiPath) || 0;
    if (this._customCache.has(customApiPath) && now - lastTime < CACHE_TTL_MS) {
      return this._customCache.get(customApiPath);
    }

    const url = customApiPath.startsWith('http') ? customApiPath : `${this.baseUrl}${customApiPath}`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': DEFAULT_UA },
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) return [];

      const rawCiphertext = (await res.text()).trim();
      const decryptedJson = SkTechCrypto.decryptPrimary(rawCiphertext);
      const rawItems = JSON.parse(decryptedJson);

      const subChannels = [];
      for (let i = 0; i < rawItems.length; i++) {
        const entry = rawItems[i];
        const ch = typeof entry.channel === 'string' ? JSON.parse(entry.channel) : entry.channel;
        if (!ch) continue;

        subChannels.push({
          id: `sktech_subch_${i}`,
          title: ch.name || `Channel ${i + 1}`,
          logo: ch.logo || '',
          links: ch.links || '',
          linkNames: ch.link_names || ['FHD']
        });
      }

      this._customCache.set(customApiPath, subChannels);
      this._customCacheTime.set(customApiPath, now);
      return subChannels;
    } catch (_) {
      return [];
    }
  }

  /**
   * Resolves a 24/7 channel item into playable Stremio StreamEntities
   * Strict Constraints: 0 Server Bandwidth, 0 Cloudflare Workers
   *
   * @param {Object} channel - Normalized channel object from fetchChannels()
   * @returns {Promise<Array<Object>>} Playable stream entities
   */
  async resolveChannelStream(channel) {
    if (!channel) return [];

    // Case 0: Pre-unpacked channel from M3U bouquet (e.g. Big Boss, Sun NXT, CricHD, Sony LIV)
    if (channel.url && channel.type === 'direct_m3u') {
      const parsed = SkTechEmbedExtractor.parseDelimited(channel.url);
      const streamHeaders = Object.keys(channel.headers || {}).length > 0 ? channel.headers : parsed.headers;

      const clearkeyObj = (channel.drmScheme === 'clearkey' && channel.drmLicense)
        ? SkTechCrypto.formatClearKey(channel.drmLicense)
        : undefined;

      const streamUrl = parsed.url || channel.url;
      const isPlainHls = !clearkeyObj && streamUrl.includes('.m3u8');

      return [{
        name: '⚡ Direct Stream',
        title: `SK Tech | ${channel.title}${channel.group ? ' (' + channel.group + ')' : ''}`,
        url: streamUrl,
        language: channel.language,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: streamHeaders
          }
        },
        clearkey: clearkeyObj,
        score: isPlainHls ? 96 : 95
      }];
    }

    // Case 1: Custom channel item with link definition (`pro/<id>.txt`)
    const linkPath = channel.links || (channel.type === 'pro' ? channel.api : '');
    if (linkPath && linkPath.startsWith('pro/')) {
      const streams = await SkTechMatchResolver.resolveMatchStreams(linkPath, channel.title);
      if (streams && streams.length > 0) {
        return streams;
      }
      // Fallback: emit direct URL from the channel entry if pro/ resolution returned empty
      const fallbackUrl = channel.url || channel.api;
      if (fallbackUrl && fallbackUrl.startsWith('http')) {
        const parsed = SkTechEmbedExtractor.parseDelimited(fallbackUrl);
        return [{
          name: '⚡ Direct Stream',
          title: `SK Tech | ${channel.title}${channel.group ? ' (' + channel.group + ')' : ''}`,
          url: parsed.url || fallbackUrl,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: Object.keys(channel.headers || {}).length > 0 ? channel.headers : parsed.headers
            }
          },
          score: 80
        }];
      }
      return [];
    }

    // Case 2: Custom channel pointing to a group definition (`channels/<id>.txt`)
    if (channel.type === 'custom' && channel.api) {
      const groupItems = await this.fetchCustomChannelGroup(channel.api);
      if (groupItems.length > 0 && groupItems[0].links) {
        const streams = await SkTechMatchResolver.resolveMatchStreams(groupItems[0].links, channel.title);
        if (streams && streams.length > 0) {
          return streams;
        }
      }
      // Fallback: emit direct URL from the channel entry if group resolution returned empty
      const fallbackUrl = channel.url || (channel.api.startsWith('http') ? channel.api : '');
      if (fallbackUrl && fallbackUrl.startsWith('http')) {
        const parsed = SkTechEmbedExtractor.parseDelimited(fallbackUrl);
        return [{
          name: '⚡ Direct Stream',
          title: `SK Tech | ${channel.title}${channel.group ? ' (' + channel.group + ')' : ''}`,
          url: parsed.url || fallbackUrl,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: Object.keys(channel.headers || {}).length > 0 ? channel.headers : parsed.headers
            }
          },
          score: 80
        }];
      }
    }

    // Case 3: Direct M3U feed (e.g. FanCode, Sony Live, JioTV+)
    const targetUrl = channel.api || channel.url || '';
    if (targetUrl) {
      const parsed = SkTechEmbedExtractor.parseDelimited(targetUrl);
      if (!parsed.url) return [];

      // If URL points to an .m3u playlist, parse constituent streams
      if (parsed.url.toLowerCase().includes('.m3u')) {
        try {
          const res = await fetch(parsed.url, {
            headers: parsed.headers,
            signal: AbortSignal.timeout(6000)
          });
          if (res.ok) {
            const m3uText = await res.text();
            const channels = this.parseM3uBouquet(m3uText, channel.title, parsed.headers);
            const streams = [];

            for (const ch of channels) {
              const clearkeyObj = (ch.drmScheme === 'clearkey' && ch.drmLicense)
                ? SkTechCrypto.formatClearKey(ch.drmLicense)
                : undefined;

              const isPlainHls = !clearkeyObj && (ch.url || '').includes('.m3u8');

              streams.push({
                name: '⚡ Direct Stream',
                title: `SK Tech | ${ch.title}`,
                url: ch.url,
                language: ch.language,
                behaviorHints: {
                  notWebReady: true,
                  proxyHeaders: {
                    request: ch.headers
                  }
                },
                clearkey: clearkeyObj,
                score: isPlainHls ? 96 : 90
              });
            }

            if (streams.length > 0) {
              return streams;
            }
          }
        } catch (_) {}
      }

      return [{
        name: '⚡ Direct Stream',
        title: `SK Tech | ${channel.title} (24/7 Live)`,
        url: parsed.url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: parsed.headers
          }
        },
        score: 95
      }];
    }

    return [];
  }
}

module.exports = new SkTechChannelResolver();
