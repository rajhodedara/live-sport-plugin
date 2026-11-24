'use strict';

/**
 * Live event channel search over the Trex generic catalog
 * (`flix-live-tv-v2-trex`).
 *
 * Team channels cover a fixture only when the broadcaster carries the club
 * permanently; a one-off game has no team channel at all and instead appears
 * as its own per-game entry in the catalog (`NEXT | WOFFORD VS. WAKE FOREST
 * | ... | 8K EXCLUSIVE`). Those entries are found by the upstream search
 * endpoint, one query per fixture:
 *
 *   GET ${base}/catalog/tv/flix-live-tv-v2-trex/search=<tokens>.json
 *
 * Every query costs a request against a shared budget, so the class keeps a
 * short-lived per-fixture cache, drops listed events that do not name the
 * other team, ranks the rest by the catalog quality/group score, and sweeps
 * a whole live window with a bounded number of searches.
 *
 * The manifest URL is never logged; failures report a bounded kind only.
 */

const { eventQueryTokens, normalizeName, entryScore } = require('./TrexCatalogKeys');

const CATALOG_ID = 'flix-live-tv-v2-trex';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_SEARCHES = 20;

/** A kickoff is searchable from 15 minutes before to 4 hours after now. */
const WINDOW_BEFORE_MS = 15 * 60 * 1000;
const WINDOW_AFTER_MS = 4 * 3600 * 1000;

const SEARCH_TIMEOUT_MS = 8000;
const SEARCH_BODY_LIMIT = 512 * 1024;
const MAX_CANDIDATES = 2;
const BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function errorKind(error) {
  return String((error && (error.code || error.name)) || 'Error').replace(/[^a-z0-9_.-]/gi, '').slice(0, 80);
}

function toCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : fallback;
}

/** `KAFKA_MANIFEST_URL` without the trailing `/manifest.json`. */
function baseFromEnv() {
  return String(process.env.KAFKA_MANIFEST_URL || '')
    .replace(/\/manifest\.json$/, '')
    .replace(/\/+$/, '');
}

/** Fixture team names arrive as `{ name }` objects or bare strings. */
function teamName(team) {
  if (team == null) return '';
  if (typeof team === 'string') return team;
  return String(team.name == null ? '' : team.name);
}

/** Kickoff in ms from an ISO date or an epoch number stored in a string. */
function kickoffMs(match) {
  const value = match && match.date;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** The `GROUP|` prefix of a catalog name unless the meta carries a group field. */
function metaGroup(meta) {
  if (meta.group) return String(meta.group);
  if (meta.grp) return String(meta.grp);
  const name = String(meta.name || '');
  const bar = name.indexOf('|');
  return bar === -1 ? '' : name.slice(0, bar).trim();
}

function bodyTooLarge() {
  const error = new Error('event search body too large');
  error.code = 'BODY_TOO_LARGE';
  return error;
}

/**
 * Reads a JSON body, refusing anything above `SEARCH_BODY_LIMIT` bytes. A
 * declared `content-length` is checked before the read; a streaming body is
 * read chunk by chunk and cancelled as soon as the cap is crossed, so it is
 * never buffered whole. A stub without a stream falls back to `text()`, which
 * does buffer first and only measures afterwards.
 */
async function readJsonBody(response) {
  const headers = response.headers;
  const declared = typeof headers?.get === 'function' ? Number(headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > SEARCH_BODY_LIMIT) throw bodyTooLarge();

  const stream = response.body;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;
      const chunk = typeof value === 'string'
        ? Buffer.from(value, 'utf8')
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      total += chunk.length;
      if (total > SEARCH_BODY_LIMIT) {
        try {
          await reader.cancel();
        } catch {
          // the cap is enforced either way
        }
        throw bodyTooLarge();
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > SEARCH_BODY_LIMIT) throw bodyTooLarge();
    return JSON.parse(text);
  }
  return response.json();
}

class TrexEventSearch {
  constructor({
    baseUrl,
    fetchImpl = global.fetch,
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    concurrency = DEFAULT_CONCURRENCY,
    now = () => Date.now()
  } = {}) {
    this.baseUrl = String(baseUrl == null ? baseFromEnv() : baseUrl)
      .replace(/\/manifest\.json$/, '')
      .replace(/\/+$/, '');
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.ttlMs = toCount(ttlMs, DEFAULT_TTL_MS);
    this.maxEntries = toCount(maxEntries, DEFAULT_MAX_ENTRIES);
    this.concurrency = Math.max(1, Math.min(8, toCount(concurrency, DEFAULT_CONCURRENCY) || 1));
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.cache = new Map();
  }

  /** True when a kickoff falls in the +/- window searched for live events. */
  isInWindow(kickoff, nowMs = this.now()) {
    const kickoffAt = Number(kickoff);
    const reference = Number(nowMs);
    if (!Number.isFinite(kickoffAt) || !Number.isFinite(reference)) return false;
    return kickoffAt >= reference - WINDOW_BEFORE_MS && kickoffAt <= reference + WINDOW_AFTER_MS;
  }

  /** Fresh cache entry for a fixture, or null. Never touches the network. */
  _fresh(fixtureId) {
    const key = String(fixtureId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  /** Cached candidates for a fixture id; `[]` when absent or expired. */
  cachedFor(fixtureId) {
    const entry = this._fresh(fixtureId);
    return entry ? entry.candidates.slice() : [];
  }

  /** Stores one fixture result, evicting the oldest entry above `maxEntries`. */
  _remember(fixtureId, candidates) {
    const key = String(fixtureId);
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), candidates });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  /** Keeps listings that name the other team, best scored first, at most two. */
  _rank(metas, requiredToken) {
    const candidates = [];
    for (const meta of Array.isArray(metas) ? metas : []) {
      const id = meta && meta.id ? String(meta.id) : '';
      const name = meta && meta.name ? String(meta.name) : '';
      if (!id || !name) continue;
      if (requiredToken && !normalizeName(name).split(' ').includes(requiredToken)) continue;
      const group = metaGroup(meta);
      candidates.push({ id, name, group, score: entryScore(name, group) });
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
  }

  /**
   * One upstream search; throws on transport, HTTP, body and parse failures.
   * With a `budget`, every attempt spends one unit before it is sent, retries
   * included; an exhausted budget throws without touching the network.
   */
  async _request(tokens, budget) {
    if (budget) {
      if (budget.remaining <= 0) {
        const error = new Error('event search budget exhausted');
        error.code = BUDGET_EXHAUSTED;
        throw error;
      }
      budget.remaining -= 1;
    }
    if (!this.baseUrl) {
      const error = new Error('missing upstream base URL');
      error.code = 'NO_BASE_URL';
      throw error;
    }
    if (!this.fetchImpl) {
      const error = new Error('missing fetch implementation');
      error.code = 'NO_FETCH';
      throw error;
    }
    const query = encodeURIComponent(tokens.join(' '));
    const url = `${this.baseUrl}/catalog/tv/${CATALOG_ID}/search=${query}.json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal
      });
      if (!response || !response.ok) {
        const status = Number(response && response.status) || 0;
        const error = new Error('event search request failed');
        error.code = status ? `HTTP_${status}` : 'NO_RESPONSE';
        throw error;
      }
      const body = await readJsonBody(response);
      return Array.isArray(body && body.metas) ? body.metas : [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Candidates for one token list, or null when the request failed. */
  async _searchTokens(tokens, requiredToken, budget) {
    try {
      return this._rank(await this._request(tokens, budget), requiredToken);
    } catch (error) {
      if (error && error.code !== BUDGET_EXHAUSTED) {
        console.warn(`[TrexEventSearch] search failed: ${errorKind(error)}`);
      }
      return null;
    }
  }

  /**
   * Searches the first token of the home team's name, keeping only listings
   * that also name the away team; a query that finds nothing is retried once
   * without its last token. Returns null when a request failed.
   */
  async _search(match, budget = null) {
    const home = teamName(match && match.team1);
    const away = teamName(match && match.team2);
    const primary = home || away;
    const secondary = home ? away : '';
    const tokens = eventQueryTokens(primary);
    if (tokens.length === 0) return [];
    const requiredToken = normalizeName(secondary).split(' ').filter(Boolean)[0] || '';

    let candidates = await this._searchTokens(tokens, requiredToken, budget);
    if (candidates === null) return null;
    if (candidates.length === 0 && tokens.length > 1) {
      candidates = await this._searchTokens(tokens.slice(0, -1), requiredToken, budget);
      if (candidates === null) return null;
    }
    return candidates;
  }

  /**
   * Event channel candidates for one fixture, from the cache when fresh.
   * `force` skips the cache read. Failures are not cached, so the next call
   * retries upstream; a settled empty result is cached like any other.
   */
  async findForFixture(match, { force = false } = {}) {
    return this._resolve(match, { force });
  }

  /**
   * Shared body of `findForFixture` and `sweep`; `budget` bounds the upstream
   * requests the search may spend, trim-and-retry included.
   */
  async _resolve(match, { force = false, budget = null } = {}) {
    const fixtureId = match && match.id != null ? String(match.id) : '';
    if (!fixtureId) return [];
    if (!force) {
      const entry = this._fresh(fixtureId);
      if (entry) return entry.candidates.slice();
    }
    const candidates = await this._search(match, budget);
    if (candidates === null) return [];
    this._remember(fixtureId, candidates);
    return candidates.slice();
  }

  /**
   * Searches every fixture in the live window, nearest kickoff first, with at
   * most `maxSearches` upstream requests across `concurrency` workers. A
   * trim-and-retry spends a second unit, so the walk stops and the remaining
   * fixtures keep `[]` once the budget is spent. Cached fixtures are free.
   */
  async sweep(matches, { maxSearches = DEFAULT_MAX_SEARCHES } = {}) {
    const nowMs = this.now();
    const live = [];
    for (const match of Array.isArray(matches) ? matches : []) {
      const id = match && match.id != null ? String(match.id) : '';
      if (!id) continue;
      const kickoff = kickoffMs(match);
      if (!Number.isFinite(kickoff) || !this.isInWindow(kickoff, nowMs)) continue;
      live.push({ id, match, distance: Math.abs(kickoff - nowMs) });
    }
    live.sort((a, b) => a.distance - b.distance);

    const results = new Map(live.map((item) => [item.id, this.cachedFor(item.id)]));
    const pending = live.filter((item) => !this._fresh(item.id));
    const budget = { remaining: toCount(maxSearches, DEFAULT_MAX_SEARCHES) };

    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, pending.length) }, async () => {
      while (budget.remaining > 0 && cursor < pending.length) {
        const item = pending[cursor];
        cursor += 1;
        results.set(item.id, await this._resolve(item.match, { budget }));
      }
    });
    await Promise.all(workers);
    return results;
  }
}

module.exports = { TrexEventSearch };
