'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const { getRequestBaseUrl } = require('../config');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Dual-Ping Auth Token Manager ───────────────────────────────────────────
// Centralized token ring shared across all requests.
// Implements primary (vypn.net) -> fallback (lokke.app) failover.
// Proactive background refresh when < 3 minutes remain before expiration.

class VavooTokenManager {
  constructor() {
    this.sig = null;
    this.validUntil = 0;
    this.refreshPromise = null;
    this.activeSource = null;
  }

  isValid() {
    return Boolean(this.sig && Date.now() < this.validUntil);
  }

  needsRefresh() {
    return !this.sig || Date.now() > (this.validUntil - 3 * 60 * 1000);
  }

  _parseValidUntil(addonSig) {
    let validUntil = Date.now() + 20 * 60 * 1000; // 20-minute default
    try {
      const decoded = JSON.parse(Buffer.from(String(addonSig), 'base64').toString('utf8'));
      const dataObj = typeof decoded.data === 'string' ? JSON.parse(decoded.data) : decoded.data;
      if (typeof dataObj?.validUntil === 'number') {
        validUntil = dataObj.validUntil;
      }
    } catch (_) {
      // Keep default
    }
    return validUntil;
  }

  async _pingVypn(fetchFn) {
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const nowMs = Date.now();
    const pingBody = {
      token: '',
      reason: 'app-focus',
      locale: 'de',
      theme: 'dark',
      metadata: {
        device: { type: 'phone', uniqueId },
        os: { name: 'android', version: '14', abis: ['arm64-v8a'], host: 'android' },
        app: { platform: 'android' },
        version: { package: 'net.vypn.app', binary: '1.4.1', js: '1.4.1' }
      },
      appFocusTime: 0,
      playerActive: false,
      playDuration: 0,
      devMode: false,
      hasAddon: true,
      castConnected: false,
      package: 'net.vypn.app',
      version: '1.4.1',
      process: 'app',
      firstAppStart: nowMs - 86400000,
      lastAppStart: nowMs,
      ipLocation: null,
      adblockEnabled: true,
      migrationApplied: false,
      migrationTargetInstalled: false,
      proxy: { supported: ['ss'], engine: 'Mu', ssVersion: '2022', enabled: false, autoServer: true, id: '' },
      iap: { supported: false, error: '' }
    };

    const res = await fetchFn('https://www.vypn.net/api/app/ping', {
      method: 'POST',
      headers: {
        'user-agent': 'okhttp/4.12.0',
        'accept': 'application/json',
        'content-type': 'application/json; charset=utf-8',
        'Accept-Language': 'de'
      },
      body: JSON.stringify(pingBody),
      timeoutMs: 8000
    });

    if (!res.ok) throw new Error(`vypn.net ping returned HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.addonSig) throw new Error('vypn.net ping response missing addonSig');
    return { sig: j.addonSig, validUntil: this._parseValidUntil(j.addonSig), source: 'vypn.net' };
  }

  async _pingLokke(fetchFn) {
    const now = Date.now();
    const pingBody = {
      token: "ldCvE092e7gER0rVIajfsXIvRhwlrAzP6_1oEJ4q6HH89QHt24v6NNL_jQJO219hiLOXF2hqEfsUuEWitEIGN4EaHHEHb7Cd7gojc5SQYRFzU3XWo_kMeryAUbcwWnQrnf0-",
      reason: "app-blur",
      locale: "de",
      theme: "dark",
      metadata: {
        device: { type: "Handset", brand: "google", model: "Nexus", name: "21081111RG", uniqueId: "a1b2c3d4e5f60718" },
        os: { name: "android", version: "7.1.2", abis: ["arm64-v8a"], host: "android" },
        app: { platform: "android", version: "1.1.0", buildId: "97215000", engine: "hbc85", signatures: ["6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e"], installer: "com.android.vending" },
        version: { package: "app.lokke.main", binary: "1.1.0", js: "1.1.0" },
        platform: { isAndroid: true, isIOS: false, isTV: false, isWeb: false, isMobile: true, isWebTV: false, isElectron: false }
      },
      appFocusTime: 0,
      playerActive: false,
      playDuration: 0,
      devMode: true,
      hasAddon: true,
      castConnected: false,
      package: "app.lokke.main",
      version: "1.1.0",
      process: "app",
      firstAppStart: now - 86400000,
      lastAppStart: now,
      ipLocation: null,
      adblockEnabled: false,
      proxy: { supported: ["ss", "openvpn"], engine: "openvpn", ssVersion: 1, enabled: false, autoServer: true, id: "fi-hel" },
      iap: { supported: true }
    };

    const res = await fetchFn('https://www.lokke.app/api/app/ping', {
      method: 'POST',
      headers: {
        'user-agent': 'okhttp/4.11.0',
        'accept': 'application/json',
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(pingBody),
      timeoutMs: 8000
    });

    if (!res.ok) throw new Error(`lokke.app ping returned HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.addonSig) throw new Error('lokke.app ping response missing addonSig');
    return { sig: j.addonSig, validUntil: this._parseValidUntil(j.addonSig), source: 'lokke.app' };
  }

  async _fetchDualSig(fetchFn = fetch) {
    // 1. Try Primary: vypn.net
    try {
      return await this._pingVypn(fetchFn);
    } catch (vypnErr) {
      console.warn(`[VavooProvider] Primary ping (vypn.net) failed: ${vypnErr.message}. Failing over to lokke.app...`);
    }

    // 2. Try Fallback: lokke.app
    try {
      return await this._pingLokke(fetchFn);
    } catch (lokkeErr) {
      console.error(`[VavooProvider] Secondary ping (lokke.app) failed: ${lokkeErr.message}.`);
      throw new Error(`Dual-ping authentication exhausted: vypn.net & lokke.app both unreachable.`);
    }
  }

  async getOrRefreshSig(fetchFn = fetch) {
    // Fast path: cached token is valid and not yet in refresh window
    if (this.isValid() && !this.needsRefresh()) {
      return this.sig;
    }

    // Proactive background refresh: still valid, but within 3 mins of expiry
    if (this.isValid() && this.needsRefresh() && !this.refreshPromise) {
      this.refreshPromise = this._fetchDualSig(fetchFn)
        .then(result => {
          this.sig = result.sig;
          this.validUntil = result.validUntil;
          this.activeSource = result.source;
        })
        .catch(err => console.warn('[VavooProvider] Background token refresh failed:', err.message))
        .finally(() => {
          this.refreshPromise = null;
        });
      // Return currently valid signature without blocking the user
      return this.sig;
    }

    // If a refresh is already underway, await it
    if (this.refreshPromise) {
      await this.refreshPromise;
      if (this.isValid()) return this.sig;
    }

    // Hard refresh: token missing or expired
    this.refreshPromise = this._fetchDualSig(fetchFn)
      .then(result => {
        this.sig = result.sig;
        this.validUntil = result.validUntil;
        this.activeSource = result.source;
        return result.sig;
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return await this.refreshPromise;
  }
}

// Global singleton token manager instance
const globalTokenManager = new VavooTokenManager();

// ─── Channel Catalog (lazy-loaded singleton) ────────────────────────────────
let _vavooCatalog = null;
function getVavooCatalog() {
  if (!_vavooCatalog) {
    const candidates = [
      path.resolve(__dirname, '../data/vavoo_channels.json'),
      path.resolve(__dirname, './data/vavoo_channels.json'),
      path.resolve(__dirname, './src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'dist/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'data/vavoo_channels.json'),
    ];
    const catalogPath = candidates.find(p => fs.existsSync(p));
    if (catalogPath) {
      try {
        _vavooCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      } catch (err) {
        console.error('[VavooProvider] Failed to parse vavoo_channels.json:', err.message);
        _vavooCatalog = [];
      }
    } else {
      _vavooCatalog = [];
    }
  }
  return _vavooCatalog;
}

// A single Cartoon Network card is more useful than a long list of the same
// network split by country, language, resolution, and backup feed.  Keep the
// individual catalog rows as sources so selecting the card still offers every
// regional Vavoo feed.
function getVavooChannelKey(channel) {
  const name = String(channel && channel.name || '')
    .toLowerCase()
    .replace(/\s*\.[a-z]\b/g, ' ')
    .replace(/\b(?:4k|uhd|fhd|full\s*hd|hd|sd)\b/g, ' ')
    .replace(/\(\s*backup(?:\s*\d+)?\s*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Vavoo labels the Arabic feed "CARTOON NETWORK ARABIC" while the other
  // regional feeds use simply "CARTOON NETWORK". They belong on the same card.
  if (/^(?:tr )?cartoon network(?: arabic)?$/.test(name)) {
    return 'cartoon-network';
  }
  return null;
}

function toVavooChannelSource(channel) {
  const ident = ChannelIdentityService.parseChannel(channel.name, {
    group: channel.group,
    language: channel.language,
    is4k: channel.is4k
  });

  return {
    source: 'vavoo',
    id: channel.vavooUrl,
    channelName: channel.name,
    canonicalChannel: ident.canonicalTitle,
    language: ident.language,
    country: ident.country || channel.group,
    countryCode: ident.countryCode,
    countryFlag: ident.countryFlag,
    resolution: ident.resolution,
    group: channel.group,
    is4k: channel.is4k,
    isBackup: ident.isBackup,
    isTimeshift: ident.isTimeshift,
    type: 'channel'
  };
}

// ─── Vavoo Base Sites & Mirror Domains ──────────────────────────────────────
const VAVOO_BASE_SITES = [
  'https://vavoo.to',
  'https://kool.to',
  'https://vavoo.net',
  'https://kool.ws'
];

const VAVOO_MIRROR_DOMAINS = [
  'vavoo.to',
  'kool.to',
  'vavoo.net',
  'kool.ws',
  'huhu.to',
  'oha.to',
  'voltop.net'
];

// ─── VavooProvider Class ────────────────────────────────────────────────────
class VavooProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'VavooProvider';
    this.sourceName = 'vavoo';
    this.baseIndex = 0;
    let customTm = null;
    try {
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'tokenManager')) {
        customTm = opts.tokenManager;
      }
    } catch (_) {}
    this.tokenManager = customTm || globalTokenManager;
  }

  isEnabled() {
    return process.env.VAVOO_ENABLED === 'true';
  }

  /**
   * Returns all 1,800+ verified 24/7 channels as MatchEntity objects.
   * Isolated from live fixtures via category: 'networks' and id: 'vavoo_ch_*'.
   */
  async getMatches() {
    if (!this.isEnabled()) {
      return [];
    }

    const catalog = getVavooCatalog();
    if (!Array.isArray(catalog) || catalog.length === 0) {
      return [];
    }

    const collapsedMap = new Map();
    for (const ch of catalog) {
      const specialKey = getVavooChannelKey(ch);
      const ident = ChannelIdentityService.parseChannel(ch.name, {
        group: ch.group,
        language: ch.language,
        is4k: ch.is4k
      });
      const groupKey = (ch.group && typeof ch.group === 'string' && ch.group.trim()) ? ch.group.trim() : 'all';
      const collapseKey = specialKey ? `special:${specialKey}` : `${groupKey}:${ident.identityKey}`;

      if (!collapsedMap.has(collapseKey)) {
        collapsedMap.set(collapseKey, {
          channel: ch,
          ident,
          specialKey,
          sources: []
        });
      }
      const entry = collapsedMap.get(collapseKey);
      if ((ch.is4k && !entry.channel.is4k) || (!ident.isBackup && entry.ident.isBackup)) {
        entry.channel = ch;
        entry.ident = ident;
      }
      entry.sources.push(ch);
    }

    return Array.from(collapsedMap.values()).map(({ channel: ch, ident, specialKey, sources }) => {
      const is4K = ch.is4k || sources.some(s => s.is4k) || /\b(?:4k|uhd)\b/i.test(ch.name);
      const isPopular = is4K || (ch.group === 'United Kingdom' && /sky sport|tnt sport/i.test(ch.name));

      let title = ident.canonicalTitle;
      if (specialKey === 'cartoon-network') {
        title = 'CARTOON NETWORK';
      } else if (is4K && !/4k|uhd/i.test(title)) {
        title = `${title} 4K`;
      }

      const league = specialKey === 'cartoon-network'
        ? 'Multi-region'
        : (ch.group || ident.country || 'Live TV');

      const entity = new MatchEntity({
        id: `vavoo_ch_${specialKey || ch.id}`,
        title,
        baseTitle: title,
        category: 'networks',
        date: '0', // Evergreen — 24/7 continuous channel
        popular: isPopular ? '1' : '0',
        league,
        logo: undefined,
        thumbnail_url: undefined,
        sources: sources.map(toVavooChannelSource)
      });
      entity.channelIdentityKey = ident.identityKey;
      entity.channelNumber = ident.channelNumber;
      entity.canonicalTitle = ident.canonicalTitle;
      return entity;
    });
  }

  /**
   * Resolves a direct playable stream URL for a 24/7 channel.
   * Strictly adheres to Zero Server Bandwidth: returns Sunshine CDN link + proxyHeaders.
   * Rotates through VAVOO_BASE_SITES mirrors on failure for maximum resilience.
   *
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} src
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    if (!this.isEnabled()) {
      return [];
    }

    let vavooUrl = src.id || sourceId;
    if (!vavooUrl || typeof vavooUrl !== 'string') {
      return [];
    }

    let parsedSource;
    try { parsedSource = new URL(vavooUrl); } catch (_) { return []; }
    if (!['http:', 'https:'].includes(parsedSource.protocol) || parsedSource.username || parsedSource.password) return [];
    const host = parsedSource.hostname.toLowerCase();
    const hasMirrorDomain = VAVOO_MIRROR_DOMAINS.some(d => host === d || host.endsWith('.' + d));
    if (!hasMirrorDomain) return [];

    // Normalize /watch?live=X to canonical /vavoo-iptv/play/X
    if (vavooUrl.includes('/watch')) {
      try {
        const u = new URL(vavooUrl);
        const liveId = u.searchParams.get('live');
        if (liveId) {
          vavooUrl = `https://vavoo.to/vavoo-iptv/play/${liveId}`;
        }
      } catch (_) {}
    }

    // Normalize /play/X to canonical /vavoo-iptv/play/X
    const playMatch = vavooUrl.match(/\/play\/([^/?#]+)/);
    if (playMatch && !vavooUrl.includes('/vavoo-iptv/play/')) {
      vavooUrl = `https://vavoo.to/vavoo-iptv/play/${playMatch[1]}`;
    }

    try {
      let sig = await this.tokenManager.getOrRefreshSig(this.proxyFetch.bind(this));
      let streamUrl = null;
      let lastErr = null;
      const startBaseIndex = this.baseIndex;

      for (let i = 0; i < VAVOO_BASE_SITES.length; i++) {
        const siteIndex = (startBaseIndex + i) % VAVOO_BASE_SITES.length;
        const baseSite = VAVOO_BASE_SITES[siteIndex];
        const resolveEndpoint = `${baseSite}/mediahubmx-resolve.json`;

        try {
          const resolveRes = await this.proxyFetch(resolveEndpoint, {
            method: 'POST',
            headers: {
              'user-agent': 'MediaHubMX/2',
              'accept': 'application/json',
              'content-type': 'application/json; charset=utf-8',
              'mediahubmx-signature': sig,
              'origin': baseSite,
              'referer': `${baseSite}/`
            },
            body: JSON.stringify({
              language: 'de',
              region: 'AT',
              url: vavooUrl,
              clientVersion: '3.1.0'
            }),
            timeoutMs: 8000
          });

          // Switch base site on 451, 500, 502, 503, 504 gateway/service errors
          if ([451, 500, 502, 503, 504].includes(resolveRes.status)) {
            lastErr = new Error(`HTTP ${resolveRes.status} on ${baseSite}`);
            console.warn(`[${this.name}] Resolve status ${resolveRes.status} on ${baseSite}, switching base site...`);
            this.baseIndex = (siteIndex + 1) % VAVOO_BASE_SITES.length;
            continue;
          }

          // If signature expired/rejected (401, 403), force a signature refresh and try once more on next base
          if (resolveRes.status === 401 || resolveRes.status === 403) {
            lastErr = new Error(`HTTP ${resolveRes.status} signature error on ${baseSite}`);
            console.warn(`[${this.name}] Signature rejected (${resolveRes.status}) on ${baseSite}, refreshing token...`);
            try {
              const refreshed = await this.tokenManager._fetchDualSig(this.proxyFetch.bind(this));
              if (refreshed && refreshed.sig) {
                sig = refreshed.sig;
                this.tokenManager.sig = refreshed.sig;
                this.tokenManager.validUntil = refreshed.validUntil;
              }
            } catch (_) {}
            this.baseIndex = (siteIndex + 1) % VAVOO_BASE_SITES.length;
            continue;
          }

          let j = null;
          if (resolveRes.ok) {
            try { j = await resolveRes.json(); } catch (_) {}
            if (Array.isArray(j) && j[0]?.url) {
              streamUrl = String(j[0].url);
            } else if (j?.url) {
              streamUrl = String(j.url);
            } else if (j?.data?.url) {
              streamUrl = String(j.data.url);
            }
          } else {
            try { j = await resolveRes.json(); } catch (_) {}
          }

          const isNotFound = resolveRes.status === 404 || resolveRes.status === 410;
          const hasNotFoundErr = j && typeof j.error === 'string' && /not found|no resolver/i.test(j.error);

          // Dynamic Real-Time Fallback: if play ID fails with 404/410 or "Not found" error, query catalog
          if (!streamUrl && (isNotFound || hasNotFoundErr)) {
            console.warn(`[${this.name}] Play ID failed for "${matchTitle}" (${resolveRes.status}${j?.error ? ': ' + j.error : ''}), attempting catalog fallback...`);
            const fallbackUrl = await this._fallbackResolveFromCatalog(matchTitle, src, baseSite, sig);
            if (fallbackUrl) {
              streamUrl = fallbackUrl;
            }
          }

          if (!streamUrl && !resolveRes.ok) {
            lastErr = new Error(`HTTP ${resolveRes.status} on ${baseSite}`);
            console.warn(`[${this.name}] Resolve failed on ${baseSite} for "${matchTitle}": HTTP ${resolveRes.status}`);
            continue;
          }

          if (streamUrl) {
            // Update active baseIndex to the successful one so subsequent calls start from the healthy mirror
            this.baseIndex = siteIndex;
            break;
          } else {
            console.warn(`[${this.name}] Empty URL in resolve response from ${baseSite} for "${matchTitle}"`);
          }
        } catch (fetchErr) {
          lastErr = fetchErr;
          console.warn(`[${this.name}] Network error resolving on ${baseSite}: ${fetchErr.message}, switching base site...`);
          this.baseIndex = (siteIndex + 1) % VAVOO_BASE_SITES.length;
        }
      }

      if (!streamUrl) {
        console.warn(`[${this.name}] All Vavoo base sites exhausted for "${matchTitle}". Last error: ${lastErr ? lastErr.message : 'No stream URL'}`);
        return [];
      }

      const is4K = src.is4k || /4k|uhd/i.test(matchTitle);
      const resolution = is4K ? '4K UHD' : '1080p';
      const rawChannelName = src.channelName || (matchTitle && !matchTitle.startsWith('vavoo_') ? matchTitle : 'Live TV');
      const channelLabel = rawChannelName
        .replace(/\s*[-–—]{1,3}\s*(?:Poland|Germany|UK|USA?|France|Spain|Italy|Portugal|Turkey|Netherlands|Canada|Australia|Austria|Switzerland|India|Argentina|Chile|Brazil|[A-Za-z]{2,})\s*$/i, '')
        .replace(/\s*[-–—]{2,}\s*/g, ' ')
        .replace(/\s*[–—]\s*/g, ' ')
        .replace(/\s*\.[a-z]\b/gi, ' ')
        .replace(/\s*\[live during events only\]\s*/gi, ' ')
        .replace(/\s*[\[\(]\s*(?:backup(?:\s*\d+)?|bkp|alternate|alt)\s*[\]\)]/gi, ' ')
        .replace(/\b(?:backup(?:\s*\d+)?|bkp)\b/gi, ' ')
        .replace(/\b(?:hevc|h\.?265)\b/gi, ' ')
        .replace(/\s*\[\s*raw\s*\]/gi, ' ')
        .replace(/\braw\b/gi, ' ')
        .replace(/\s*\[\s*sat\s*\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim() || rawChannelName;

      const isBackup = Boolean(src.isBackup || /\bbackup\b|\(backup\)/i.test(rawChannelName));
      const isHevc = Boolean(/\b(?:hevc|h\.?265)\b/i.test(rawChannelName));
      const isRaw = Boolean(/\braw\b/i.test(rawChannelName));
      const isServerC = Boolean(/\.c\b|server\s*c/i.test(rawChannelName));
      const isServerS = Boolean(!isServerC && (/\.s\b|server\s*s/i.test(rawChannelName)));
      const isServerB = Boolean(!isServerC && !isServerS && (/\.b\b|server\s*b/i.test(rawChannelName)));

      let serverTag = '';
      let clusterKey = 'main';
      let clusterScore = 85;

      if (isBackup) {
        if (isServerC) {
          serverTag = '[Server C - Backup]';
          clusterKey = 'c-backup';
          clusterScore = 72;
        } else if (isServerS) {
          serverTag = '[Server S - Backup]';
          clusterKey = 's-backup';
          clusterScore = 71;
        } else {
          serverTag = '[Backup]';
          clusterKey = 'backup';
          clusterScore = 70;
        }
      } else if (isHevc) {
        serverTag = '[HEVC]';
        clusterKey = 'hevc';
        clusterScore = 80;
      } else if (isRaw) {
        serverTag = '[RAW]';
        clusterKey = 'raw';
        clusterScore = 79;
      } else if (isServerC) {
        serverTag = `[Server C - ${resolution}]`;
        clusterKey = 'c';
        clusterScore = is4K ? 96 : 90;
      } else if (isServerS) {
        serverTag = `[Server S - ${resolution}]`;
        clusterKey = 's';
        clusterScore = is4K ? 95 : 88;
      } else if (isServerB) {
        serverTag = `[Server B - ${resolution}]`;
        clusterKey = 'b';
        clusterScore = is4K ? 94 : 85;
      } else {
        serverTag = `[${resolution}]`;
        clusterKey = 'main';
        clusterScore = is4K ? 95 : 85;
      }

      const BASE_URL = getRequestBaseUrl();
      const proxyUrl = streamUrl.includes('/api/manifest?url=')
        ? streamUrl
        : `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent('https://vavoo.to/')}&origin=${encodeURIComponent('https://vavoo.to')}`;

      return [new StreamEntity({
        name: 'Vavoo',
        title: `Vavoo (${channelLabel}) ${serverTag}`,
        url: proxyUrl,
        resolution: is4K ? '4K' : '1080p',
        score: clusterScore,
        cluster: clusterKey,
        serverCluster: serverTag.replace(/^\[|\]$/g, ''),
        _streamSource: isServerC ? 'Server C' : (isServerS ? 'Server S' : (isServerB ? 'Server B' : (isHevc ? 'HEVC' : (isRaw ? 'RAW' : (isBackup ? 'Backup' : undefined))))),
        language: src.language || undefined,
        channelName: channelLabel,
        canonicalChannel: src.canonicalChannel || channelLabel,
        country: src.country,
        countryCode: src.countryCode,
        countryFlag: src.countryFlag,
        group: src.group,
        is4k: is4K,
        isBackup,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': 'MediaHubMX/2',
              'Referer': 'https://vavoo.to/'
            }
          }
        }
      })];
    } catch (err) {
      console.warn(`[${this.name}] Stream resolution failed for "${matchTitle}":`, err.message);
      return [];
    }
  }

  /**
   * Real-time dynamic fallback query against mediahubmx-catalog.json
   * when static play ID returns 404/410/Not found.
   */
  async _fallbackResolveFromCatalog(matchTitle, src = {}, baseSite, sig) {
    try {
      const channelName = src.canonicalChannel || src.channelName || matchTitle || '';
      const cleanSearch = channelName
        .replace(/\s*[-–—].*$/, '')
        .replace(/\s*\.[a-z]\b/gi, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/\b(?:4k|uhd|fhd|1080p|720p|hd|sd|hevc|raw|backup)\b/gi, '')
        .trim();

      if (!cleanSearch) return null;

      const catalogEndpoint = `${baseSite}/mediahubmx-catalog.json`;
      const catalogRes = await this.proxyFetch(catalogEndpoint, {
        method: 'POST',
        headers: {
          'user-agent': 'MediaHubMX/2',
          'accept': 'application/json',
          'content-type': 'application/json; charset=utf-8',
          'mediahubmx-signature': sig,
          'origin': baseSite,
          'referer': `${baseSite}/`
        },
        body: JSON.stringify({
          language: src.language || 'de',
          region: 'AT',
          catalogId: 'iptv',
          id: 'iptv',
          adult: false,
          search: cleanSearch,
          sort: 'name',
          filter: src.group ? { group: src.group } : {},
          cursor: 0,
          clientVersion: '3.1.0'
        }),
        timeoutMs: 6000
      });

      let catData = null;
      let items = [];
      if (catalogRes.ok) {
        try {
          catData = await catalogRes.json();
          items = Array.isArray(catData?.items) ? catData.items : [];
        } catch (_) {}
      }

      if (items.length === 0 && src.group) {
        try {
          const fallbackRes = await this.proxyFetch(catalogEndpoint, {
            method: 'POST',
            headers: {
              'user-agent': 'MediaHubMX/2',
              'accept': 'application/json',
              'content-type': 'application/json; charset=utf-8',
              'mediahubmx-signature': sig,
              'origin': baseSite,
              'referer': `${baseSite}/`
            },
            body: JSON.stringify({
              language: src.language || 'de',
              region: 'AT',
              catalogId: 'iptv',
              id: 'iptv',
              adult: false,
              search: cleanSearch,
              sort: 'name',
              cursor: 0,
              clientVersion: '3.1.0'
            }),
            timeoutMs: 6000
          });
          if (fallbackRes.ok) {
            const fbData = await fallbackRes.json();
            items = Array.isArray(fbData?.items) ? fbData.items : [];
          }
        } catch (_) {}
      }

      if (items.length === 0) return null;

      const targetName = (src.channelName || src.name || matchTitle || '').toLowerCase();
      const wantsC = /\.c\b|server\s*c/i.test(targetName);
      const wantsB = /\.b\b|server\s*b/i.test(targetName);
      const wantsHevc = /\bhevc\b|\bh265\b/i.test(targetName);
      const wantsRaw = /\braw\b/i.test(targetName);
      const wantsBackup = /\bbackup\b/i.test(targetName);

      const nonEventItems = items.filter(it => !/\.s\b|live during events only/i.test(it.name || ''));
      const candidateList = nonEventItems.length > 0 ? nonEventItems : items;

      let matchedItem = null;
      if (wantsBackup) {
        matchedItem = candidateList.find(it => /\bbackup\b/i.test(it.name || ''));
      } else if (wantsHevc) {
        matchedItem = candidateList.find(it => /\bhevc\b|\bh265\b/i.test(it.name || ''));
      } else if (wantsRaw) {
        matchedItem = candidateList.find(it => /\braw\b/i.test(it.name || ''));
      } else if (wantsC) {
        matchedItem = candidateList.find(it => /\.c\b/i.test(it.name || ''));
      } else if (wantsB) {
        matchedItem = candidateList.find(it => /\.b\b/i.test(it.name || ''));
      }

      if (!matchedItem) {
        matchedItem = candidateList.find(it => /\.c\b/i.test(it.name || '')) ||
                      candidateList.find(it => /\.b\b/i.test(it.name || '')) ||
                      candidateList[0];
      }

      if (matchedItem && matchedItem.url) {
        console.log(`[${this.name}] Dynamic fallback resolved active play URL for "${matchTitle}": ${matchedItem.name} (${matchedItem.url})`);
        const freshRes = await this.proxyFetch(`${baseSite}/mediahubmx-resolve.json`, {
          method: 'POST',
          headers: {
            'user-agent': 'MediaHubMX/2',
            'accept': 'application/json',
            'content-type': 'application/json; charset=utf-8',
            'mediahubmx-signature': sig,
            'origin': baseSite,
            'referer': `${baseSite}/`
          },
          body: JSON.stringify({
            language: src.language || 'de',
            region: 'AT',
            url: matchedItem.url,
            clientVersion: '3.1.0'
          }),
          timeoutMs: 6000
        });

        if (freshRes.ok) {
          const freshJson = await freshRes.json();
          if (Array.isArray(freshJson) && freshJson[0]?.url) return String(freshJson[0].url);
          if (freshJson?.url) return String(freshJson.url);
          if (freshJson?.data?.url) return String(freshJson.data.url);
        }
      }
    } catch (err) {
      console.warn(`[${this.name}] Dynamic fallback error for "${matchTitle}":`, err.message);
    }
    return null;
  }
}

module.exports = VavooProvider;
module.exports.VavooTokenManager = VavooTokenManager;
module.exports.globalTokenManager = globalTokenManager;
module.exports.VAVOO_BASE_SITES = VAVOO_BASE_SITES;
module.exports.VAVOO_MIRROR_DOMAINS = VAVOO_MIRROR_DOMAINS;
