const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../services/ProviderOutbound');
const leafState = require('../services/LeafState');
const leafMint = require('../services/LeafMint');
const { isRateLimit } = leafMint;
const { resolveLeafInstallConfig } = require('../services/LeafInstallConfig');
const { rateLimitDelay, recordAccountRateLimit, accountCooldownRemaining } = require('../services/LeafRateLimitState');
const { checkLeafStream } = require('../services/LeafStreamProbe');
const { isInconclusiveResolutionError, inconclusiveErrorReason, markInconclusiveStreams, inconclusiveStreamsReason } = require('../services/StreamResolutionOutcome');
const { BASE_URL } = require('../config');
const { validateLeafManifestUrl } = require('../services/GuardedEgressPolicy');

// Upstream replaced the old shared-token API with a per-install config path:
//   https://sports.highfly.to/<base64url(config)>/{catalog,stream}/sport/...
// The config blob is what the official configure page issues
// (sports.highfly.to/configure -> Turnstile -> install link) and decodes to
// {"freeUserId":"<uuid>.<hash>"}. That blob is the account selector, so it is
// read from LEAF_INSTALL_CONFIG - never hardcoded. A shared literal is exactly
// what upstream revokes, and it is a per-install identity, not a build input.
//
// The old shared master token is deliberately gone: papacito.cfd answers 403
// "Authentication required" to it and the stream route replies with the
// "please reinstall" stub, so a locally minted signed URL could only ever
// produce a broken stream.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const BUDGET_MS = 8000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_CANDIDATES = 8;

function hardFailure(error) {
  if (isInconclusiveResolutionError(error)) return false;
  try {
    const seen = new Set();
    for (let current = error; current && typeof current === 'object'; current = current.cause) {
      if (seen.has(current) || seen.size >= 8) return true;
      seen.add(current);
      if (current.code === 'ERR_OUTBOUND_BLOCKED' || current.isFatal === true) return true;
    }
  } catch (_) { return true; }
  return false;
}

const filteredFailure = error => isInconclusiveResolutionError(error) || hardFailure(error) || error?.leafControl === true ||
  error?.leafDefinitive === true || error?.code === 'ERR_LEAF_STATE_UNCONFIGURED';
const controlError = (code, cause) => Object.assign(new Error('Leaf stream resolution is unavailable'), { code, cause, leafControl: true });
const safeCode = error => typeof error?.code === 'string' && /^ERR_[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'ERR_LEAF_REQUEST';

async function withSignal(operation, signal) {
  const pending = Promise.resolve(operation);
  if (signal.aborted) {
    // The action may already have been queued when its caller cancelled. Keep
    // its eventual rejection observed even though this waiter exits promptly.
    pending.catch(() => {});
    throw signal.reason;
  }
  let abort;
  try {
    return await Promise.race([pending, new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

class LeafProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'Leaf';
    // Stable source key. Aggregation code keys providers on `sourceName || name`,
    // and the live-overlay refresh selects Leaf by that key, so leaning on the
    // display name ('Leaf' vs 'leaf') is exactly how a selector silently matches
    // nothing. Same convention as DaddyLive/ReplayZone/SoccerFull.
    this.sourceName = 'leaf';
    this._installNagWarned = false;
    this._streamCache = new Map();
    this._inFlight = new Map();
    this._catalogInFlight = new Map();

    // Tri-state catalog health, same convention as DaddyLiveProvider's
    // lastScheduleOk. getMatches() answers [] for "nothing is live" AND for
    // "upstream threw", and a caller that replaces a live snapshot wholesale
    // cannot tell those apart without this flag.
    //   null = never fetched, true = last fetch parsed, false = last fetch failed
    this.lastCatalogOk = null;

    if (this.circuitBreaker) {
      this.fetchMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchMatches`, async config => {
        return this._fetchLiveMatchesInternal(config);
      }, { errorFilter: filteredFailure });

      this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (targetId, context) => {
        return this._resolveStreamsInternal(targetId, context);
      }, { errorFilter: filteredFailure });
    }
  }

  /**
   * Build the upstream base for the per-install config path.
   *
   * LEAF_API_URL stays a whole-base override on purpose: production parks the
   * source on a dead local port (http://127.0.0.1:9/leaf-disabled) to disable
   * leaf without shipping code, and that kill switch must keep working
   * verbatim - every request fails fast and the provider returns [].
   *
   * @returns {string}
   */
  static buildApiUrl() {
    return resolveLeafInstallConfig().apiBase;
  }

  _configuration() {
    try { return resolveLeafInstallConfig(); }
    catch (_) { return { configured: false, apiBase: '', origin: '' }; }
  }

  get configured() { return this._configuration().configured; }
  get apiUrl() { return this._configuration().apiBase; }
  get origin() { return this._configuration().origin; }

  _eligibleCachedStreams(cached, base, targetId) {
    if (!cached || !Array.isArray(cached.streams)) return [];
    const eligible = cached.streams.filter(stream => {
      try {
        const url = new URL(stream.url);
        const match = url.pathname.match(/^\/api\/leaf\/m3u8\/([^/]+)\/index\.m3u8$/);
        if (!match) return false;
        const state = leafState.verify(match[1]);
        return state && state.m === targetId && typeof state.s === 'string' && Boolean(leafMint.peekCachedUrl(state.m, state.s, { base }));
      } catch (_) { return false; }
    });
    return eligible.length === cached.streams.length ? cached.streams : eligible;
  }

  clearCacheForMatch(matchId) {
    if (typeof matchId !== 'string' || !matchId) return;
    const targets = new Set();
    for (const [key, entry] of this._streamCache) {
      if (entry.matchIds?.has(matchId)) {
        targets.add(key);
        this._streamCache.delete(key);
      }
    }
    for (const [key, flight] of this._inFlight) {
      if (flight.matchIds.has(matchId) || targets.has(flight.targetKey)) this._supersedeFlight(key, flight);
    }
  }

  _supersedeFlight(key, flight) {
    flight.invalidated = true;
    flight.controller.abort(new DOMException('Leaf resolution superseded', 'AbortError'));
    if (this._inFlight.get(key) === flight) this._inFlight.delete(key);
  }

  /**
   * Upstream retires the free stream API by answering every stream id with a
   * single fake entry that points at /configure ("Please reinstall the addon /
   * we have updated our free addon"). That payload used to reach the player and
   * is what renders as the "this stream is stolen, install the official addon"
   * notice, so it is dropped here: an empty list is the honest answer, never a
   * stream tile that is really an advert.
   *
   * @param {Array} streamsList
   * @returns {boolean}
   */
  static isRateLimit(streamsList) {
    return isRateLimit(streamsList);
  }

  static isInstallNag(streamsList) {
    return (Array.isArray(streamsList) ? streamsList : []).some(st => {
      if (!st) return false;
      const name = typeof st.name === 'string' ? st.name : '';
      const title = typeof st.title === 'string' ? st.title : '';
      const url = typeof st.url === 'string' ? st.url : '';
      return (/reinstall/i.test(name) || /\/configure\b/.test(url)) && !/rate limit/i.test(name) && !/rate limit/i.test(title);
    });
  }

  static async probeStreamAlive(directUrl, options = {}) {
    return (await checkLeafStream(directUrl, options)).status === 'ok';
  }

  _warnInstallNag() {
    if (this._installNagWarned) return;
    this._installNagWarned = true;
    console.warn(
      `[${this.name}] Upstream answered with the install-nag stub instead of streams. ` +
      'The free stream API is not served for this install config; leaf stays dormant until ' +
      'a fresh link is issued at sports.highfly.to/configure.'
    );
  }

  _warnUnconfigured() {
    if (this._installNagWarned) return;
    this._installNagWarned = true;
    console.warn(
      `[${this.name}] Skipped: no LEAF_INSTALL_CONFIG / LEAF_FREE_USER_ID set. ` +
      'Leaf needs the per-install config blob from sports.highfly.to/configure.'
    );
  }

  /**
   * Fetch live sporting matches from Highfly live catalog.
   * Strictly filters OUT all 24/7 TV channels.
   *
   * @returns {Promise<Array<MatchEntity>>}
   */
  async getMatches() {
    this.lastCatalogOk = false;
    const config = this._configuration();
    this._catalogBase = config.apiBase;
    if (!config.configured) {
      this._warnUnconfigured();
      return [];
    }
    if (this._catalogInFlight.has(config.apiBase)) return this._catalogInFlight.get(config.apiBase);
    const pending = Promise.resolve().then(async () => {
      try {
        const result = this.fetchMatches && typeof this.fetchMatches.fire === 'function'
          ? await this.fetchMatches.fire(config) : await this._fetchLiveMatchesInternal(config);
        return Array.isArray(result) ? result : [];
      } catch (err) {
        if (this._catalogBase === config.apiBase) this.lastCatalogOk = false;
        console.warn(`[${this.name}] Failed to fetch live matches: ${safeCode(err)}`);
        return [];
      }
    }).finally(() => {
      if (this._catalogInFlight.get(config.apiBase) === pending) this._catalogInFlight.delete(config.apiBase);
    });
    this._catalogInFlight.set(config.apiBase, pending);
    return pending;
  }

  async _fetchLiveMatchesInternal(config = this._configuration()) {
    this.lastCatalogOk = false;
    if (!config.configured) return [];
    const url = `${config.apiBase}/catalog/sport/sports_live.json`;
    const res = await impitClient.safeFetch(url, {
      headers: {
        'User-Agent': USER_AGENT, Accept: 'application/json',
        Origin: config.origin, Referer: `${config.origin}/`
      },
      timeoutMs: BUDGET_MS, maxBodyBytes: MAX_BODY_BYTES, attempts: 1
    });

    if (!res || !res.ok) {
      throw Object.assign(new Error('Leaf catalog request failed'), { code: 'ERR_LEAF_CATALOG_STATUS', upstreamStatus: res?.status || 0 });
    }
    if (res.bodyTruncated) throw Object.assign(new Error('Leaf catalog exceeds its body limit'), { code: 'ERR_LEAF_CATALOG_BODY_LIMIT' });
    let data;
    try { data = await res.json(); }
    catch (cause) { throw Object.assign(new Error('Leaf catalog metadata is invalid'), { code: 'ERR_LEAF_CATALOG_BODY', cause }); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.metas)) {
      throw Object.assign(new Error('Leaf catalog metadata is invalid'), { code: 'ERR_LEAF_CATALOG_BODY' });
    }
    const validRow = item => item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.id === 'string' && item.id.trim() && item.id.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(item.id) &&
      typeof item.name === 'string' && item.name.trim();
    const metas = data.metas.filter(validRow);
    if (data.metas.length && !metas.length) throw Object.assign(new Error('Leaf catalog rows are invalid'), { code: 'ERR_LEAF_CATALOG_BODY' });
    // An authoritative empty schedule and a valid catalog containing only TV
    // channels are both healthy; malformed metadata is not an empty schedule.
    if (!this._catalogBase || this._catalogBase === config.apiBase) this.lastCatalogOk = true;
    const matches = [];

    for (const item of metas) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name) continue;

      // Strictly exclude 24/7 channels (IDs starting with leaf: or networks category)
      if (item.id.startsWith('leaf:') || item.category === 'networks' || item.isChannel) {
        continue;
      }

      const cleanId = item.id.replace(/^streamed:/, '');
      const category = this.normalizeCategory(item.category || (Array.isArray(item.genres) ? item.genres[0] : 'other'));

      let matchDate = '0';
      if (item.releaseInfo && typeof item.releaseInfo === 'string' && item.releaseInfo !== 'LIVE') {
        const cleaned = item.releaseInfo.replace('·', '').replace(/\s+/g, ' ').trim();
        const d = new Date(cleaned);
        if (!isNaN(d.getTime())) matchDate = String(d.getTime());
      } else {
        const tsMatch = String(item.id).match(/[-_](1\d{9}|1\d{12})$/);
        if (tsMatch) {
          const tsVal = Number(tsMatch[1]);
          const epochMs = tsMatch[1].length === 10 ? tsVal * 1000 : tsVal;
          if (epochMs > 0 && Number.isFinite(epochMs)) matchDate = String(epochMs);
        }
      }

      // Upstream publishes live fixtures without a parseable date (releaseInfo 'LIVE',
      // id without a timestamp), which left date='0'. Dateless events sort behind every
      // timed one, so a live Leaf match never survived the 100-meta catalogue cap and no
      // tile was published even when the provider resolved fine. A live fixture is
      // happening now, so 'now' is both honest and sortable.
      if (matchDate === '0') matchDate = String(Date.now());
      matches.push(new MatchEntity({
        id: `leaf_${cleanId}`,
        aliasIds: [item.id, cleanId],
        title: item.name,
        category,
        date: matchDate,
        status: 'live',
        sources: [{
          source: 'leaf',
          id: item.id,
          name: item.name
        }]
      }));
    }

    return matches;
  }

  /**
   * Resolve live streams for a match.
   * Strictly isolates Leaf (papacito.cfd) streams and publishes signed application
   * state. Upstream credentials are requested through the official mint endpoint
   * when the playlist is fetched; they cannot be minted locally.
   *
   * @param {string} sourceId
   * @param {string} matchCategory
   * @param {string} matchTitle
   * @param {Object} src
   * @returns {Promise<Array<StreamEntity>>}
   */
  async resolveStream(sourceId, matchCategory, matchTitle, src = {}, opts = {}) {
    opts = { ...opts, forceRefresh: Boolean(opts.forceRefresh || src?.forceRefresh), skipCache: Boolean(opts.skipCache || src?.skipCache) };
    const targetId = src?.id || sourceId;
    if (typeof targetId !== 'string' || !targetId.trim() || Buffer.byteLength(targetId, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(targetId)) return [];
    const config = this._configuration();
    if (!config.configured) {
      this._warnUnconfigured();
      return [];
    }
    if (opts.signal?.aborted) {
      return hardFailure(opts.signal.reason) ? [] : markInconclusiveStreams([], inconclusiveErrorReason(opts.signal.reason) || 'cancelled');
    }
    const key = JSON.stringify([config.apiBase, targetId]);
    // Cancellable requests own their transport and never another caller's.
    // Non-cancellable requests still coalesce under the ordinary target key.
    const flightKey = opts.signal ? Symbol('cancellable Leaf resolution') : key;
    const matchId = typeof opts.matchId === 'string' && opts.matchId ? opts.matchId : sourceId;
    const cached = this._streamCache.get(key);
    if (cached && typeof matchId === 'string') cached.matchIds.add(matchId);
    const eligible = () => opts.skipCache || this._streamCache.get(key) !== cached ? [] : this._eligibleCachedStreams(cached, config.apiBase, targetId);
    const fallback = () => { const streams = eligible(); return streams.length ? streams : null; };
    const ttlMs = Math.min(10 * 60 * 1000, Math.max(30 * 1000, Number(process.env.LEAF_STREAM_CACHE_TTL_MS) || 180 * 1000));
    if (opts.forceRefresh) {
      for (const [candidateKey, flight] of this._inFlight) {
        if (flight.targetKey === key) this._supersedeFlight(candidateKey, flight);
      }
    }
    if (!opts.forceRefresh && !opts.skipCache && cached && Date.now() - cached.at < ttlMs) {
      if (!cached.streams.length) return cached.streams;
      const streams = fallback();
      if (streams) return streams;
      this._streamCache.delete(key);
    }
    if (accountCooldownRemaining(config.apiBase) > 0) return fallback() || markInconclusiveStreams([], 'unavailable');
    const existing = this._inFlight.get(flightKey);
    if (existing) {
      if (typeof matchId === 'string') existing.matchIds.add(matchId);
      return existing.promise;
    }
    if (this._inFlight.size >= 32) return fallback() || markInconclusiveStreams([], 'capacity');

    const controller = new AbortController();
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const deadline = performance.now() + BUDGET_MS;
    const timer = setTimeout(() => controller.abort(new DOMException('Leaf resolution deadline', 'TimeoutError')), BUDGET_MS);
    const matchIds = new Set(cached?.matchIds || []);
    if (typeof matchId === 'string') matchIds.add(matchId);
    const flight = { invalidated: false, controller, matchIds, targetKey: key, promise: null };
    const context = { ...config, signal, flight, remaining: () => {
      signal.throwIfAborted();
      const left = Math.ceil(deadline - performance.now());
      if (left <= 0) throw new DOMException('Leaf resolution deadline', 'TimeoutError');
      return Math.min(BUDGET_MS, left);
    } };
    flight.promise = Promise.resolve().then(async () => {
      try {
        const operation = Promise.resolve().then(() => this.fetchStreams && typeof this.fetchStreams.fire === 'function'
          ? this.fetchStreams.fire(targetId, context) : this._resolveStreamsInternal(targetId, context));
        const result = await withSignal(operation, signal);
        if (flight.invalidated) return markInconclusiveStreams([], 'cancelled');
        const reason = inconclusiveStreamsReason(result);
        if (reason) return result.length ? result : fallback() || result;
        if (!Array.isArray(result)) return fallback() || markInconclusiveStreams([], 'unavailable');
        if (!opts.skipCache) {
          for (const associated of this._streamCache.get(key)?.matchIds || []) matchIds.add(associated);
          this._streamCache.set(key, { streams: result, at: Date.now(), matchIds });
          if (this._streamCache.size > 200) this._streamCache.delete(this._streamCache.keys().next().value);
        }
        return result;
      } catch (error) {
        if (flight.invalidated) return markInconclusiveStreams([], 'cancelled');
        console.warn(`[${this.name}] Failed to resolve streams: ${safeCode(error)}`);
        if (hardFailure(error) || error?.leafDefinitive) {
          if (this._streamCache.get(key) === cached) this._streamCache.delete(key);
          return [];
        }
        if (opts.signal?.aborted) return markInconclusiveStreams([], inconclusiveErrorReason(error) || 'cancelled');
        return fallback() || markInconclusiveStreams([], inconclusiveErrorReason(error) || (signal.aborted ? 'cancelled' : 'unavailable'));
      } finally {
        clearTimeout(timer);
        if (this._inFlight.get(flightKey) === flight) this._inFlight.delete(flightKey);
      }
    });
    this._inFlight.set(flightKey, flight);
    return flight.promise;
  }

  async _resolveStreamsInternal(targetId, context) {
    if (!context) {
      const config = this._configuration();
      const started = performance.now();
      context = { ...config, signal: AbortSignal.timeout(BUDGET_MS), remaining: () => Math.max(1, BUDGET_MS - Math.ceil(performance.now() - started)) };
    }
    if (!context.configured) return [];
    context.remaining();
    if (accountCooldownRemaining(context.apiBase) > 0) throw controlError('ERR_LEAF_STREAM_QUOTA');
    const url = `${context.apiBase}/stream/sport/${encodeURIComponent(targetId)}.json`;
    const res = await impitClient.safeFetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Origin: context.origin, Referer: `${context.origin}/` },
      signal: context.signal, timeoutMs: context.remaining(), maxBodyBytes: MAX_BODY_BYTES, attempts: 1
    });
    context.remaining();
    if (res?.status === 429) {
      const delay = recordAccountRateLimit(context.apiBase, rateLimitDelay(res));
      throw Object.assign(controlError('ERR_LEAF_STREAM_RATE_LIMIT'), { upstreamStatus: 429, rateLimit: true, retryAfterMs: delay });
    }
    if (!res || !res.ok) {
      throw Object.assign(new Error('Leaf stream metadata request failed'), {
        code: 'ERR_LEAF_STREAM_STATUS', upstreamStatus: res?.status || 0,
        leafDefinitive: [401, 403, 404, 410].includes(res?.status)
      });
    }
    if (res.bodyTruncated) throw controlError('ERR_LEAF_BODY_LIMIT');
    let data;
    try { data = await res.json(); }
    catch (cause) { throw controlError('ERR_LEAF_STREAM_BODY', cause); }
    context.remaining();
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.streams)) throw controlError('ERR_LEAF_STREAM_BODY');
    const streamsList = data.streams;
    if (LeafProvider.isRateLimit(streamsList)) {
      const delay = recordAccountRateLimit(context.apiBase, rateLimitDelay(res, streamsList));
      throw Object.assign(controlError('ERR_LEAF_STREAM_RATE_LIMIT'), { upstreamStatus: 429, rateLimit: true, retryAfterMs: delay });
    }
    if (LeafProvider.isInstallNag(streamsList)) {
      this._warnInstallNag();
      return [];
    }
    if (streamsList.length && !streamsList.some(row => row && typeof row === 'object' && !Array.isArray(row) && typeof row.url === 'string' && row.url.trim())) {
      throw controlError('ERR_LEAF_STREAM_BODY');
    }
    const candidates = [];
    for (const st of streamsList) {
      if (!st || typeof st.url !== 'string' || !st.url) continue;
      try { validateLeafManifestUrl(st.url); } catch (_) { continue; }
      const parsed = new URL(st.url);
      const isPapacito = parsed.hostname === 'papacito.cfd' || parsed.hostname.endsWith('.papacito.cfd');
      if (isPapacito && !parsed.search) continue;
      let slug = (parsed.pathname.match(/\/m3u\/([a-z0-9-]+)\/live\.m3u8/i) || [])[1] || '';
      if (!slug && !isPapacito) {
        slug = (parsed.pathname.replace(/\.m3u8$/i, '').match(/\/([a-z0-9_-]+)$/i) || [])[1] || '';
      }
      if (slug.length > 256) slug = slug.slice(0, 256);
      candidates.push({ st, directUrl: st.url, slug, referer: `${context.origin}/`, origin: context.origin });
      if (candidates.length === MAX_CANDIDATES) break;
    }
    if (!candidates.length) return [];
    const checked = await Promise.all(candidates.map(async candidate => {
      const result = await checkLeafStream(candidate.directUrl, { signal: context.signal,
        timeoutMs: Math.min(1500, context.remaining()), origin: context.origin, referer: candidate.referer, userAgent: USER_AGENT });
      return { candidate, result };
    }));
    context.remaining();
    for (const { candidate, result } of checked) {
      if (result?.status === 'rejected' && leafMint.peekCachedUrl(targetId, candidate.slug, { base: context.apiBase }) === candidate.directUrl) {
        leafMint.invalidate(targetId, candidate.slug, { base: context.apiBase });
      }
    }
    const uncertain = checked.find(({ result }) => result?.status === 'inconclusive');
    const validCandidates = checked.filter(({ result }) => result?.status === 'ok').map(({ candidate }) => candidate);
    const resolved = [];

    for (const { st, directUrl, slug, referer, origin } of validCandidates) {
      context.remaining();
      const stateToken = leafState.sign({ m: targetId, s: slug });
      const manifestProxyUrl = `${BASE_URL}/api/leaf/m3u8/${stateToken}/index.m3u8`;
      leafMint.seed(targetId, slug, directUrl, { base: context.apiBase });
      if (leafMint.peekCachedUrl(targetId, slug, { base: context.apiBase }) !== directUrl) continue;

      const rawName = typeof st.name === 'string' ? st.name : '';
      const rawTitle = typeof st.title === 'string' ? st.title : '';

      // Determine resolution & quality
      let resolution = '1080p';
      let quality = 'FHD';
      if (/3840x2160|4k/i.test(rawTitle) || /4k/i.test(rawName)) {
        resolution = '4K';
        quality = '4K UHD';
      } else if (/1280x720|720p/i.test(rawTitle) || /720p/i.test(rawName)) {
        resolution = '720p';
        quality = 'HD';
      }

      // Bitrate as display label ("6.2 Mbps") matching the addon-wide
      // convention in streams.js — raw bps renders as "6200000" in the UI.
      let bitrate = null;
      const bitrateMatch = rawTitle.match(/~?([\d.]+)\s*Mbps/i);
      if (bitrateMatch) {
        const bps = Math.round(parseFloat(bitrateMatch[1]) * 1000000);
        bitrate = bps >= 1000000
          ? `${(bps / 1000000).toFixed(1)} Mbps`
          : `${Math.round(bps / 1000)} kbps`;
      }

      // Channel label cleanup: strip the upstream "🔒 Leaf (Strong) ·" branding
      // entirely (no lock emoji, no "Strong") plus parenthetical junk like
      // "(A)..." so streams.js' first-parens extraction picks the broadcaster.
      let channelLabel = rawName
        .replace(/🔒/g, '')
        .replace(/^\s*Leaf\b\s*(?:\([^)]*\))?\s*[·:\-–]?\s*/i, '')
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/\bStrong\b/gi, '')
        .replace(/^\s*[:\-–]\s*/, '')
        .replace(/\s*\.{2,}\s*$/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      resolved.push(new StreamEntity({
        name: `Leaf [${quality}]`,
        title: channelLabel ? `(${channelLabel}) ${quality}` : `Leaf Stream · ${quality}`,
        url: manifestProxyUrl,
        resolution,
        quality,
        bitrate,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              'Referer': referer,
              'Origin': origin,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
            }
          }
        },
        _source: 'leaf'
      }));
    }

    return !resolved.length && uncertain ? markInconclusiveStreams(resolved, uncertain.result.reason || 'unavailable') : resolved;
  }
}

module.exports = LeafProvider;
