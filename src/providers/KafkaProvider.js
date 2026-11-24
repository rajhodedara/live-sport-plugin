'use strict';

const BaseProvider = require('./BaseProvider');
const ChannelIdentityService = require('../services/ChannelIdentityService');
const ChannelCountryService = require('../services/ChannelCountryService');
const StreamEntity = require('../domain/StreamEntity');
const { isBlockedStream } = require('../services/StreamPolicy');
const { getRequestBaseUrl } = require('../config');

const GENERIC_CATALOG_ID = 'flix-live-tv-v2-trex';
const DEFAULT_CATALOG_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_ITEMS = 1000;
const DEFAULT_MAX_CATALOGS = 50;
const DEFAULT_INDEX_TTL_MS = 900000; // 15 minutes

/** Sources injected per fixture when KAFKA_INJECTION_CAP is unset: event, team, label. */
const DEFAULT_INJECTION_CAP = 3;

const SPORTS_CATALOG_PATTERN = /\b(?:sport|sports|event|events|ppv|football|soccer|cricket|basketball|baseball|american football|nfl|nba|nhl|hockey|tennis|motorsport|motor racing|formula 1|f1|mma|ufc|boxing|wrestling|rugby|golf|volleyball|handball|cycling|athletics|darts|snooker|aussie rules|gaelic football|hurling|netball|badminton|table tennis|swimming|diving|gymnastics|skiing|biathlon|skating|futsal|beach soccer|water polo|lacrosse|field hockey|horse racing|triathlon|esports|chess|espn|dazn|flosports|flo sports|bein|tsn)\b/i;

function safeErrorKind(error) {
  const value = error && (error.code || error.name || error.statusCode);
  return String(value || 'Error').replace(/[^a-z0-9_.-]/gi, '').slice(0, 80) || 'Error';
}

class KafkaProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Kafka';
    this.sourceName = 'kafka';
    this.lastErrorStatus = null;
    this._index = new Map();
    this._lastIndexTime = 0;
    this._refreshPromise = null;
    this._indexTtlMs = DEFAULT_INDEX_TTL_MS;
    this.lastRefreshSucceeded = null;
    this.lastRefreshErrorKind = null;
    this.lastIndexedChannelCount = 0;

    this.catalogStore = (opts && opts.catalogStore) || null;
    this.eventSearch = (opts && opts.eventSearch) || null;
  }

  get configured() {
    const enabled = process.env.KAFKA_ENABLED === 'true';
    const manifestUrl = process.env.KAFKA_MANIFEST_URL;
    return enabled && Boolean(manifestUrl) && this.validateManifestUrl(manifestUrl);
  }

  /**
   * Validates manifest URL: HTTPS only, no user/pass, ends with /manifest.json
   */
  validateManifestUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return false;
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.username || parsed.password) return false;
      if (!parsed.pathname.endsWith('/manifest.json')) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Redacts secret tokens from manifest / stream URLs for safe logging.
   * e.g. "https://flixnest.stream/u/SECRET/manifest.json" -> "https://flixnest.stream/.../manifest.json"
   */
  getSafeLogUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return '[invalid-url]';
    try {
      const parsed = new URL(urlStr);
      const parts = parsed.pathname.split('/').filter(Boolean);
      const filename = parts.length > 0 ? parts[parts.length - 1] : '';
      return `${parsed.protocol}//${parsed.host}/.../${filename}`;
    } catch (_) {
      return '[invalid-url]';
    }
  }

  /**
   * Builds catalog URL from manifest URL and catalog ID, with optional pagination skip
   */
  buildCatalogUrl(manifestUrl, catalogId, skip = 0) {
    if (!this.validateManifestUrl(manifestUrl)) {
      throw new Error(`Invalid manifest URL: ${this.getSafeLogUrl(manifestUrl)}`);
    }
    const base = manifestUrl.replace(/\/manifest\.json$/, '');
    if (skip && Number.isFinite(skip) && skip > 0) {
      return `${base}/catalog/tv/${encodeURIComponent(catalogId)}/skip=${skip}.json`;
    }
    return `${base}/catalog/tv/${encodeURIComponent(catalogId)}.json`;
  }

  /**
   * Filters manifest catalogs to sports/event catalogs.
   * A non-empty allowlist is an exact operator override. When it is empty,
   * sports catalogs are discovered from their manifest id/name taxonomy.
   * The generic Trex/all-TV catalog is always rejected.
   */
  selectSportsCatalogs(manifest, allowlist) {
    if (!manifest || !Array.isArray(manifest.catalogs)) return [];
    const allowed = new Set(
      (Array.isArray(allowlist) ? allowlist : String(allowlist || '').split(','))
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const candidates = manifest.catalogs.filter((cat) => {
      if (!cat || !cat.id) return false;
      if (cat.id === GENERIC_CATALOG_ID) return false;
      if (cat.type && cat.type !== 'tv') return false;
      if (allowed.size > 0) return allowed.has(cat.id);
      const taxonomy = `${cat.id} ${cat.name || ''}`.replace(/[-_]+/g, ' ');
      return SPORTS_CATALOG_PATTERN.test(taxonomy);
    });
    return candidates.slice(0, DEFAULT_MAX_CATALOGS);
  }

  /**
   * Bounded catalog fetch with pagination.
   */
  async fetchCatalogMetas(catalogId, options = {}) {
    if (!this.configured) return [];
    const manifestUrl = this.manifestUrl || process.env.KAFKA_MANIFEST_URL;
    const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
    const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
    const maxItems = options.maxItems || DEFAULT_MAX_ITEMS;
    const timeoutMs = options.timeoutMs || DEFAULT_CATALOG_TIMEOUT_MS;
    const maxBodyBytes = options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
    const throwOnFailure = options.throwOnFailure === true;

    const allMetas = [];
    this.lastErrorStatus = null;

    for (let page = 0; page < maxPages; page++) {
      const skip = page * pageSize;
      const url = this.buildCatalogUrl(manifestUrl, catalogId, skip);

      try {
        const res = await this.proxyFetch(url, {
          timeoutMs,
          maxBodyBytes,
          diagnosticOwner: 'kafka_catalog'
        });

        if (!res || !res.ok) {
          this.lastErrorStatus = res ? res.status : null;
          console.warn(`[KafkaProvider] Catalog request failed: ${res ? res.status : 'no-response'} for ${catalogId}`);
          if (throwOnFailure) {
            const failure = new Error('Kafka catalog request failed');
            failure.code = res ? `KAFKA_CATALOG_HTTP_${res.status}` : 'KAFKA_CATALOG_NO_RESPONSE';
            throw failure;
          }
          break;
        }

        const data = await res.json();
        const metas = data && Array.isArray(data.metas) ? data.metas : [];
        const remaining = Math.max(0, maxItems - allMetas.length);
        allMetas.push(...metas.slice(0, remaining));

        if (allMetas.length >= maxItems || metas.length < pageSize) {
          break;
        }
      } catch (err) {
        if (throwOnFailure) throw err;
        console.warn(`[KafkaProvider] Error fetching catalog ${catalogId}: ${safeErrorKind(err)}`);
        break;
      }
    }

    return allMetas;
  }

  /**
   * Refreshes the sports channel index in single-flight mode and caches according to TTL.
   * If refresh fails, retains last-good immutable snapshot.
   */
  async refreshIndex() {
    if (!this.configured) {
      return this._index;
    }

    const ttlMs = Number(process.env.KAFKA_INDEX_TTL_MS) || this._indexTtlMs;
    if (this._index.size > 0 && this._lastIndexTime > 0 && (Date.now() - this._lastIndexTime < ttlMs)) {
      return this._index;
    }

    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = (async () => {
      try {
        const manifestUrl = this.manifestUrl || process.env.KAFKA_MANIFEST_URL;
        const res = await this.proxyFetch(manifestUrl, {
          timeoutMs: DEFAULT_CATALOG_TIMEOUT_MS,
          diagnosticOwner: 'kafka_manifest'
        });

        if (!res || !res.ok) {
          this.lastErrorStatus = res ? res.status : null;
          this.lastRefreshSucceeded = false;
          this.lastRefreshErrorKind = res ? `KAFKA_MANIFEST_HTTP_${res.status}` : 'KAFKA_MANIFEST_NO_RESPONSE';
          console.warn(`[KafkaProvider] Manifest fetch failed: ${res ? res.status : 'no-response'}`);
          return this._index;
        }

        const manifest = await res.json();
        const allowlist = this.allowlist || process.env.KAFKA_CATALOG_ALLOWLIST || '';
        const sportsCatalogs = this.selectSportsCatalogs(manifest, allowlist);
        if (sportsCatalogs.length === 0) {
          this.lastRefreshSucceeded = true;
          this.lastRefreshErrorKind = null;
          this.lastIndexedChannelCount = 0;
          return this._index;
        }

        const newIndex = new Map();

        for (const cat of sportsCatalogs) {
          const metas = await this.fetchCatalogMetas(cat.id, { throwOnFailure: true });
          const detectedCatCountry = cat.name ? ChannelCountryService.detectChannelCountry(cat.name) : null;

          for (const meta of metas) {
            if (!meta || !meta.id || !meta.name) continue;
            const parsed = ChannelIdentityService.parseChannel(meta.name, {
              country: detectedCatCountry ? detectedCatCountry.country : undefined,
              countryCode: detectedCatCountry ? detectedCatCountry.name : undefined
            });
            const key = parsed.identityKey;
            if (!key || key === 'unknown' || key === 'unknownchannel') continue;

            const entry = {
              id: meta.id,
              channelName: parsed.canonicalTitle || meta.name,
              rawName: meta.name,
              catalogId: cat.id,
              identityKey: key,
              channelNumber: parsed.channelNumber,
              country: parsed.country,
              countryCode: parsed.countryCode,
              language: parsed.language,
              resolution: parsed.resolution,
              isBackup: parsed.isBackup,
              isTimeshift: parsed.isTimeshift
            };

            const existing = newIndex.get(key) || [];
            existing.push(entry);
            newIndex.set(key, existing);
          }
        }

        if (newIndex.size > 0) {
          this._index = newIndex;
          this._lastIndexTime = Date.now();
        }
        this.lastRefreshSucceeded = true;
        this.lastRefreshErrorKind = null;
        this.lastIndexedChannelCount = [...newIndex.values()].reduce((total, entries) => total + entries.length, 0);
      } catch (err) {
        this.lastRefreshSucceeded = false;
        this.lastRefreshErrorKind = safeErrorKind(err);
        console.warn(`[KafkaProvider] Index refresh failed: ${this.lastRefreshErrorKind}`);
      }
      return this._index;
    })().finally(() => {
      this._refreshPromise = null;
    });

    return this._refreshPromise;
  }

  /**
   * Resolves a raw broadcaster name to a Kafka channel source in O(1).
   * Refuses ambiguous identities, conflicting country context, mismatched channel numbers,
   * backups, and timeshift variants unless explicitly requested.
   */
  createSource(rawChannelName, context = {}) {
    if (!rawChannelName || typeof rawChannelName !== 'string') return null;
    const parsed = ChannelIdentityService.parseChannel(rawChannelName, context);
    const key = parsed.identityKey;
    if (!key || key === 'unknown' || key === 'unknownchannel') return null;

    const list = this._index.get(key);
    if (!list || list.length === 0) return null;

    // Filter by channel number strictness
    let candidates = list.filter((c) => c.channelNumber === parsed.channelNumber);
    if (candidates.length === 0) return null;

    // Filter by backup status
    if (parsed.isBackup) {
      candidates = candidates.filter((c) => c.isBackup);
    } else {
      candidates = candidates.filter((c) => !c.isBackup);
    }
    if (candidates.length === 0) return null;

    // Filter by timeshift status
    if (parsed.isTimeshift) {
      candidates = candidates.filter((c) => c.isTimeshift);
    } else {
      candidates = candidates.filter((c) => !c.isTimeshift);
    }
    if (candidates.length === 0) return null;

    // Resolve country context
    const reqCountryInfo =
      (context && (context.countryCode || context.country) && (ChannelCountryService.getCountryInfo(context.countryCode) || ChannelCountryService.getCountryInfo(context.country))) ||
      (parsed.countryCode || parsed.country ? (ChannelCountryService.getCountryInfo(parsed.countryCode) || ChannelCountryService.getCountryInfo(parsed.country)) : null);

    if (reqCountryInfo) {
      candidates = candidates.filter((c) => {
        const candCountryInfo = (c.countryCode || c.country)
          ? (ChannelCountryService.getCountryInfo(c.countryCode) || ChannelCountryService.getCountryInfo(c.country))
          : null;
        if (!candCountryInfo) return false;
        return candCountryInfo.name === reqCountryInfo.name || candCountryInfo.country === reqCountryInfo.country;
      });
      if (candidates.length === 0) return null;
    } else {
      // No country specified: if candidates have multiple distinct countries, it's ambiguous
      const countries = new Set(
        candidates
          .map((c) => {
            const info = (c.countryCode || c.country)
              ? (ChannelCountryService.getCountryInfo(c.countryCode) || ChannelCountryService.getCountryInfo(c.country))
              : null;
            return info ? info.name : null;
          })
          .filter(Boolean)
      );
      if (countries.size > 1) {
        return null; // Ambiguous
      }
    }

    if (candidates.length === 0) return null;

    // Refuse ambiguous multiple distinct IDs
    const distinctIds = new Set(candidates.map((c) => c.id));
    if (distinctIds.size > 1) {
      return null;
    }

    const chosen = candidates[0];
    return {
      source: 'kafka',
      id: chosen.id,
      channelName: chosen.channelName,
      catalogId: chosen.catalogId,
      ...(chosen.country ? { country: chosen.country } : {}),
      ...(chosen.language ? { language: chosen.language } : {}),
      type: 'channel'
    };
  }

  /** True when the Trex catalog store is open and answering. */
  isCoverageReady() {
    return Boolean(
      this.catalogStore &&
        typeof this.catalogStore.isReady === 'function' &&
        this.catalogStore.isReady()
    );
  }

  /** Event search is on unless KAFKA_EVENT_SEARCH_ENABLED is exactly "false". */
  _eventSearchEnabled() {
    return process.env.KAFKA_EVENT_SEARCH_ENABLED !== 'false';
  }

  _injectionCap() {
    const raw = Number(process.env.KAFKA_INJECTION_CAP);
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_INJECTION_CAP;
  }

  /** Team names of a fixture, from objects with a name or from plain strings. */
  teamNamesOf(match) {
    if (!match) return [];
    const names = [];
    for (const team of [match.team1, match.team2]) {
      const value = team && typeof team === 'object' ? team.name : team;
      if (typeof value === 'string' && value.trim()) names.push(value.trim());
    }
    return names;
  }

  /**
   * Builds the Kafka sources a fixture deserves, best first: the live event
   * feed (only inside the live window), then the broadcaster of the match
   * (the source labels), then the club channels as the last fallback. Ids are
   * deduped, so an id reached twice keeps its earlier, stronger mode, and
   * KAFKA_INJECTION_CAP bounds the result (default 3).
   */
  createSourcesForFixture(match, { now = Date.now() } = {}) {
    if (!match || !this.isCoverageReady()) return [];
    const cap = this._injectionCap();
    if (cap <= 0) return [];

    const out = [];
    const seen = new Set();
    const add = (candidate, matchMode) => {
      if (!candidate || !candidate.id || seen.has(candidate.id) || out.length >= cap) return;
      seen.add(candidate.id);
      const rawName = String(candidate.name || candidate.channelName || '');
      // The catalog prefixes a routing group (`US| NBA TV HD`, `NBA TEAM| CHICAGO
      // BULLS`). It is not part of the name a viewer should read, so the label
      // starts after it; the group still supplies the country when it is a code.
      const bar = rawName.indexOf('|');
      const channelName = (bar === -1 ? rawName : rawName.slice(bar + 1)).trim();
      const groupInfo = candidate.country ? null : ChannelCountryService.getCountryInfo(candidate.group);
      out.push({
        source: 'kafka',
        id: candidate.id,
        channelName,
        catalogId: GENERIC_CATALOG_ID,
        matchMode,
        ...(candidate.country ? { country: candidate.country } : groupInfo ? { country: groupInfo.country } : {}),
        ...(candidate.language ? { language: candidate.language } : {})
      });
    };

    if (this.eventSearch && this._eventSearchEnabled()) {
      const kickoff = Number(match.date);
      if (Number.isFinite(kickoff) && this.eventSearch.isInWindow(kickoff, now)) {
        for (const candidate of this.eventSearch.cachedFor(match.id) || []) add(candidate, 'event');
      }
    }

    for (const source of Array.isArray(match.sources) ? match.sources : []) {
      if (!source || source.source === 'kafka') continue;
      const label = source.channelName || source.channel_name || source.channel;
      if (!label || typeof label !== 'string') continue;
      const context = {};
      const country = source.country || match.country;
      const countryCode = source.countryCode || match.countryCode;
      if (country) context.country = country;
      if (countryCode) context.countryCode = countryCode;
      // One source per label: the store's ranking already put the fixture's own
      // market first, and a second candidate is usually a foreign feed.
      for (const hit of (this.catalogStore.findChannel(label, context) || []).slice(0, 1)) add(hit, 'label');
      if (out.length >= cap) break;
    }

    for (const name of this.teamNamesOf(match)) {
      for (const hit of this.catalogStore.findTeam(name) || []) add(hit, 'team');
      if (out.length >= cap) break;
    }

    return out;
  }

  /** Searches the live window for event channels and returns how many fixtures gained one. */
  async sweepEvents(matches, { maxSearches } = {}) {
    if (!this.eventSearch || !this._eventSearchEnabled() || !Array.isArray(matches) || matches.length === 0) return 0;
    try {
      const results = await this.eventSearch.sweep(matches, maxSearches === undefined ? {} : { maxSearches });
      let gained = 0;
      if (results && typeof results.forEach === 'function') {
        results.forEach((candidates) => {
          if (Array.isArray(candidates) && candidates.length > 0) gained += 1;
        });
      }
      return gained;
    } catch (err) {
      console.warn(`[KafkaProvider] event sweep failed: ${safeErrorKind(err)}`);
      return 0;
    }
  }

  /**
   * Streams of the fixture's event feed, resolved on the click path. Returns
   * [] outside the live window, when the search is disabled, or on any
   * failure: the caller keeps its other sources either way.
   */
  async resolveEventStreams(match, opts = {}) {
    if (!this.eventSearch || !this._eventSearchEnabled() || !match) return [];
    const now = Number.isFinite(opts && opts.now) ? opts.now : Date.now();
    const kickoff = Number(match.date);
    if (!Number.isFinite(kickoff) || !this.eventSearch.isInWindow(kickoff, now)) return [];

    let candidates;
    try {
      candidates = (await this.eventSearch.findForFixture(match)) || [];
    } catch (err) {
      console.warn(`[KafkaProvider] event search failed: ${safeErrorKind(err)}`);
      return [];
    }

    const streams = [];
    for (const candidate of candidates.slice(0, 2)) {
      if (!candidate || !candidate.id) continue;
      const src = { channelName: candidate.name || '', matchMode: 'event' };
      if (candidate.country) src.country = candidate.country;
      try {
        const resolved = await this.resolveStream(candidate.id, match.category, match.title, src, opts);
        if (Array.isArray(resolved)) streams.push(...resolved);
      } catch (err) {
        console.warn(`[KafkaProvider] event stream resolve failed: ${safeErrorKind(err)}`);
      }
    }
    return streams;
  }
  /**
   * Kafka is enrichment only; it publishes zero standalone MatchEntity rows.
   */
  async getMatches() {
    return [];
  }

  /**
   * Resolves a Kafka stream source via the upstream Stremio /stream/tv route.
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}, opts = {}) {
    if (!this.configured || !sourceId) {
      return [];
    }

    try {
      const manifestUrl = this.manifestUrl || process.env.KAFKA_MANIFEST_URL;
      const base = manifestUrl.replace(/\/manifest\.json$/, '');
      const streamUrl = `${base}/stream/tv/${encodeURIComponent(sourceId)}.json`;

      const timeoutMs = (opts && opts.timeoutMs) || 8000;
      const res = await this.proxyFetch(streamUrl, {
        signal: opts && opts.signal,
        timeoutMs,
        maxBodyBytes: 512 * 1024,
        diagnosticOwner: 'kafka_stream'
      });

      if (!res || !res.ok) {
        return [];
      }

      const data = await res.json();
      const rawStreams = data && Array.isArray(data.streams) ? data.streams : [];
      const streams = [];

      const channelLabel = (src && (src.channelName || src.name)) || '';

      for (const s of rawStreams) {
        if (!s || !s.url || typeof s.url !== 'string') continue;
        if (s.externalUrl || s.infoHash || s.ytId) continue;
        if (isBlockedStream(s)) continue;

        let title = channelLabel;
        if (s.title && s.title !== channelLabel) {
          title = channelLabel ? `${channelLabel} - ${s.title}` : s.title;
        } else if (s.name && s.name !== channelLabel) {
          title = channelLabel ? `${channelLabel} - ${s.name}` : s.name;
        }
        if (!title) title = 'Live Stream';

        const BASE_URL = getRequestBaseUrl();
        let streamUrl = s.url;
        if (!streamUrl.includes('/api/manifest?url=')) {
          const reqHeaders = (s.behaviorHints && (s.behaviorHints.proxyHeaders?.request || s.behaviorHints.proxyHeaders)) || {};
          const referer = reqHeaders.Referer || reqHeaders.referer || '';
          const origin = reqHeaders.Origin || reqHeaders.origin || '';
          let proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}`;
          if (referer) proxyUrl += `&referer=${encodeURIComponent(referer)}`;
          if (origin) proxyUrl += `&origin=${encodeURIComponent(origin)}`;
          streamUrl = proxyUrl;
        }

        const entity = new StreamEntity({
          name: 'Kafka',
          title,
          url: streamUrl,
          behaviorHints: s.behaviorHints,
          resolution: s.resolution,
          quality: s.quality || s.name,
          channelName: channelLabel,
          sourceName: this.sourceName,
          country: src && src.country,
          language: (src && src.language) || s.language
        });

        streams.push(entity);
      }

      return streams;
    } catch (err) {
      console.warn(`[KafkaProvider] resolveStream failed: ${safeErrorKind(err)}`);
      return [];
    }
  }
}

module.exports = KafkaProvider;
