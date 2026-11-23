# MovieBox Live Sports + TV Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new Nuvio providers — `MovieBoxSportsProvider` (live football/basketball fixtures + HLS streams from `aisports.mobi`) and `MovieBoxTVProvider` (3,657 linear TV channels across 145 countries) — via the MovieBox TV API at `tv.aoneroom.com`, fully wired into the existing DI/aggregator/stream-dispatch stack.

**Architecture:** A shared crypto helper (`movieboxCrypto.js`) computes all five gateway headers and holds a 5-minute in-memory visitor-token cache; both providers call it rather than duplicating signing logic. Each provider is a plain CommonJS class that extends `BaseProvider`, performs only `proxyFetch → parse → return []`, and emits direct CDN HLS URLs with `behaviorHints.proxyHeaders`. Registration follows the mandatory three-point pattern (container + aggregator + streams dispatch).

**Tech Stack:** Node ≥ 22, CommonJS (`src/`), `crypto` (built-in `md5` via `createHash`, `createHmac`), `BaseProvider.proxyFetch` → guarded egress stack, awilix DI, Jest inline fixtures.

**Spec:** `docs/MOVIEBOX_TV_API_SPECIFICATION_AND_STREAM_VERIFICATION.md`

## Global Constraints

- CommonJS only in `src/` — no `import`/`export` syntax anywhere
- All external HTTP via `this.proxyFetch(url, opts)` — never raw `fetch`, `undici`, or `impit` (I10 / D8)
- No bulk video bytes through the VPS — emit direct CDN URLs with `behaviorHints.proxyHeaders` (I1 / D1)
- No DASH or ClearKey streams — all MovieBox streams are plain Apple HLS; pass through as-is (I8 / D2)
- `timeoutMs` required on every `proxyFetch` call — missing it defaults to 15s×3 and burns egress budget
- Return `[]` on any parse or network failure in `getMatches()` — never throw out of that method
- `ERR_OUTBOUND_CAPACITY` / `ERR_NATIVE_*` are not retryable — let them surface as 503
- Providers are leaf nodes: no `CacheService` reads/writes, no route mounting, no module-level timers (I3)
- Three-point registration required for every provider: `src/container.js` + aggregator wiring + `src/streams.js` dispatch (I4)
- `this.sourceName` must be lowercase and match the `source` key emitted in `MatchEntity.sources[]`
- `MatchEntity.date` must be an epoch-millisecond string (`parseTimezone(...).toString()`)
- Tests parse **inline JSON fixtures** — no network calls in test suite, no `nock`

## Review Focus

- **Sports stream 404 during pre-match**: `resolveStream` calls `detail-v1` and `MatchNotStart` status returns valid-looking URLs that serve 404. Test that `resolveStream` returns `[]` when `matchStatus !== 'MatchIng'` and no live segment is available. *(Task 3, step 1)*
- **Visitor token race on cold start**: two concurrent `getMatches` calls may both attempt a fresh visitor-login simultaneously. Test that `movieboxCrypto.getVisitorToken()` resolves to the same token for both callers when a request is in-flight. *(Task 1, step 1)*
- **TV channel `name` field is `null`**: some entries in `tv-channel-list-by-country` have `name: null`. Test that `MovieBoxTVProvider._parseChannel()` falls back to `channelId` as the channel title rather than emitting `null`. *(Task 4, step 1)*
- **Visitor token expiry mid-session**: the JWT from visitor-login has a finite lifetime (~24h observed). Test that `getVisitorToken()` re-fetches after the 5-minute in-memory TTL, not just on first call, by advancing the internal clock. *(Task 1, step 1)*
- **Category mapping unknown sport**: the `aggregate-v1` response occasionally includes sport types not in the canonical set (e.g. `esports`, `volleyball`). Test that `normalizeCategory()` maps them to `other` and that the resulting entity is still returned (not dropped). *(Task 2, step 1)*

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/providers/movieboxCrypto.js` | **Create** | Gateway signing (all 5 headers), visitor-token cache, `makeMovieBoxRequest` |
| `src/providers/MovieBoxSportsProvider.js` | **Create** | `getMatches()` from `aggregate-v1`, `resolveStream()` from `detail-v1` |
| `src/providers/MovieBoxTVProvider.js` | **Create** | `getMatches()` from country+channel-list, `resolveStream()` from `tv-channel` |
| `src/container.js` | **Modify** | `require` + `asClass().singleton()` for both providers |
| `src/services/MatchAggregator.js` | **Modify** | Add both providers to the `this.providers` array in `syncMatches()` |
| `src/streams.js` | **Modify** | Add two `else if` branches in `dispatchToProvider` |
| `tests/movieboxCrypto.test.js` | **Create** | Unit tests for signing helpers and token-cache behaviour |
| `tests/movieboxSportsProvider.test.js` | **Create** | Unit tests for match parsing and stream extraction (inline fixtures) |
| `tests/movieboxTVProvider.test.js` | **Create** | Unit tests for channel parsing and stream extraction (inline fixtures) |

---

## Task 1: Gateway Crypto Helper

**Files:**
- Create: `src/providers/movieboxCrypto.js`
- Test: `tests/movieboxCrypto.test.js`

**Interfaces:**
- Consumes: Node `crypto` built-in; `BaseProvider.proxyFetch` is NOT available here (plain module, not a class). Use `require('../services/ProviderOutbound').safeFetch` for the visitor-login call, with `guardExternal: true` implied by the guarded stack. Actually — to avoid coupling, accept `fetchFn` as a parameter to `getVisitorToken(fetchFn)` so tests inject a stub. For production use, `MovieBoxSportsProvider` and `MovieBoxTVProvider` will call `movieboxCrypto.getVisitorToken(this.proxyFetch.bind(this))`.
- Produces:
  - `buildHeaders(method, path, body?)` → `Object` — returns all 5 gateway headers as a plain object (keys: `'X-Client-Build'`, `'x-client-token'`, `'x-client-info'`, `'x-tr-signature'`, `'Content-Type'`)
  - `getVisitorToken(fetchFn)` → `Promise<string>` — returns cached JWT or fetches fresh one via `fetchFn`; cache TTL is 5 minutes (300 000 ms)
  - `makeMovieBoxRequest(path, fetchFn, opts?)` → `Promise<Object>` — builds headers, calls `fetchFn`, parses JSON, throws on `code !== 0`; `opts.method` defaults to `'GET'`, `opts.body` defaults to `null`, `opts.token` injects the Authorization header

- [ ] **Step 1: Write failing tests**

```js
// tests/movieboxCrypto.test.js
'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
}));

const crypto = require('../src/providers/movieboxCrypto');

describe('buildHeaders', () => {
  test('returns all five required header keys', () => {
    const h = crypto.buildHeaders('GET', '/wefeed-tv-bff/sport/aggregate-v1');
    expect(Object.keys(h)).toEqual(expect.arrayContaining([
      'X-Client-Build', 'x-client-token', 'x-client-info', 'x-tr-signature', 'Content-Type'
    ]));
  });

  test('x-client-token format is "<ms>,<32-char-hex>"', () => {
    const h = crypto.buildHeaders('GET', '/test');
    const [ms, hash] = h['x-client-token'].split(',');
    expect(Number(ms)).toBeGreaterThan(0);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  test('x-tr-signature format is "<ms>|2|<base64>"', () => {
    const h = crypto.buildHeaders('GET', '/test');
    const parts = h['x-tr-signature'].split('|');
    expect(parts[1]).toBe('2');
    expect(Buffer.from(parts[2], 'base64').length).toBeGreaterThan(0);
  });

  test('X-Client-Build format is "<part1>.<32-char-hex>"', () => {
    const h = crypto.buildHeaders('GET', '/test');
    const [part1, hash] = h['X-Client-Build'].split('.');
    expect(part1).toMatch(/^\d+$/);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('getVisitorToken', () => {
  test('calls fetchFn once and caches the token for subsequent calls', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ code: 0, data: { token: 'jwt-abc' } })
    });
    // Clear module cache to reset singleton state
    jest.resetModules();
    const freshCrypto = require('../src/providers/movieboxCrypto');
    const t1 = await freshCrypto.getVisitorToken(mockFetch);
    const t2 = await freshCrypto.getVisitorToken(mockFetch);
    expect(t1).toBe('jwt-abc');
    expect(t2).toBe('jwt-abc');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('re-fetches after TTL expires', async () => {
    jest.useFakeTimers();
    jest.resetModules();
    const freshCrypto = require('../src/providers/movieboxCrypto');
    const mockFetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { token: 'first' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ code: 0, data: { token: 'second' } }) });
    await freshCrypto.getVisitorToken(mockFetch);
    jest.advanceTimersByTime(301_000); // past the 300s TTL
    const t2 = await freshCrypto.getVisitorToken(mockFetch);
    expect(t2).toBe('second');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- tests/movieboxCrypto.test.js`  
  Expected: FAIL — `Cannot find module '../src/providers/movieboxCrypto'`

- [ ] **Step 3: Implement `src/providers/movieboxCrypto.js`**

  Constants at top of file (copy verbatim from spec):
  ```
  GATEWAY_SECRET = 'Base64Decode("76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O")'  — decode at module load
  CERT_TAG = '03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410oneroom'
  PACKAGE_NAME = 'com.community.mbox.tv'
  VERSION_CODE = 50020132
  API_HOST = 'https://tv.aoneroom.com'
  TOKEN_TTL_MS = 300_000
  ```

  `buildHeaders(method, path, body = null)`:
  - `nowMs = Date.now()`
  - `x-client-token`: reverse `String(nowMs)`, md5-hex it, join with comma
  - `X-Client-Build`: `s = Math.floor(nowMs/1000)`, `ms = (nowMs % 1000) * 1000`, `rnd = randomInt(0,999)`, `part1 = \`${s}${String(ms).padStart(6,'0')}${rnd}\``, `hash = md5hex(CERT_TAG + part1)`, value = `\`${part1}.${hash}\``
  - `x-client-info`: JSON.stringify object with `device_id` (32-char hex, generated once at module load), `os_version: "14"`, `gaid` (UUID v4 shape, generated once), `package_name`, `version_code`, `X-Client-Build`
  - Canonical path: split path at `?`, sort query params alphabetically by key, rejoin
  - `x-tr-signature`: build sign string as 7 newline-delimited fields (METHOD, `application/json`, `application/json`, body byte length or empty, nowMs, md5hex(body) or empty, canonicalPath), HmacMD5(GATEWAY_SECRET, signString), base64-encode the digest, prefix `\`${nowMs}|2|\``
  - Return plain object with all 5 headers + `'Content-Type': 'application/json'`

  `getVisitorToken(fetchFn)`:
  - Module-level `let _cachedToken = null, _cacheExpiry = 0`
  - If `Date.now() < _cacheExpiry` return `_cachedToken`
  - Also handle concurrent calls: module-level `let _inflightTokenPromise = null`; if in-flight, return that promise; otherwise create, store, await, clear `_inflightTokenPromise`, update cache, return token
  - POST to `${API_HOST}/wefeed-tv-bff/user/visitor-login?host=tv.aoneroom.com` with signed headers and `body: '{}'`
  - Set `_cacheExpiry = Date.now() + TOKEN_TTL_MS`

  `makeMovieBoxRequest(path, fetchFn, { method = 'GET', body = null, token = null } = {})`:
  - Build headers via `buildHeaders(method, path, body)`
  - Add `Authorization: Bearer ${token}` if token provided
  - Call `fetchFn(API_HOST + path, { method, headers, body, timeoutMs: 8000, attempts: 2 })`
  - Parse JSON, throw if `data.code !== 0`
  - Return `data.data`

  `module.exports = { buildHeaders, getVisitorToken, makeMovieBoxRequest }`

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- tests/movieboxCrypto.test.js`  
  Expected: All PASS

- [ ] **Step 5: Syntax-check**

  Run: `node --check src/providers/movieboxCrypto.js`  
  Expected: exits 0 with no output

- [ ] **Step 6: Commit**

  ```bash
  git add src/providers/movieboxCrypto.js tests/movieboxCrypto.test.js
  git commit -m "feat(moviebox): add gateway crypto helper with visitor-token cache"
  ```

---

## Task 2: MovieBox Sports Provider

**Files:**
- Create: `src/providers/MovieBoxSportsProvider.js`
- Test: `tests/movieboxSportsProvider.test.js`

**Interfaces:**
- Consumes: `BaseProvider` from `'./BaseProvider'`; `movieboxCrypto` from `'./movieboxCrypto'`; `MatchEntity` from `'../domain/MatchEntity'`
- Produces:
  - `this.sourceName = 'moviebox_sports'`
  - `this.name = 'MovieBox Sports'`
  - `async getMatches()` → `MatchEntity[]`
  - `async resolveStream(sourceId, matchCategory, matchTitle, _src)` → `StreamEntity[]`

Sport category mapping (apply inside `getMatches()` via `this.normalizeCategory()`):
```
'football'    → 'football'
'basketball'  → 'basketball'
'tennis'      → 'other'
'baseball'    → 'baseball'
'mma'         → 'mma'
 anything else → 'other'   (BaseProvider.normalizeCategory handles this)
```

- [ ] **Step 1: Write failing tests**

```js
// tests/movieboxSportsProvider.test.js
'use strict';
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM'); }),
  destroy: jest.fn(async () => {})
}));
jest.mock('../src/services/ProviderOutbound', () => ({
  request: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  safeFetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  fetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
}));

const MovieBoxSportsProvider = require('../src/providers/MovieBoxSportsProvider');
const container = require('../src/container');

const AGGREGATE_FIXTURE = {
  code: 0,
  data: {
    list: [
      {
        matchId: 'MB_S_1001',
        homeTeam: 'Real Madrid',
        awayTeam: 'Barcelona',
        leagueName: 'La Liga',
        sportType: 'football',
        matchStatus: 'MatchNotStart',
        matchTime: '1748000000000',
        thumbnail: null,
      },
      {
        matchId: 'MB_S_1002',
        homeTeam: 'LA Lakers',
        awayTeam: 'Boston Celtics',
        leagueName: 'NBA',
        sportType: 'basketball',
        matchStatus: 'MatchIng',
        matchTime: '1747990000000',
        thumbnail: null,
      },
      {
        matchId: 'MB_S_1003',
        homeTeam: 'Team A',
        awayTeam: 'Team B',
        leagueName: 'eSports League',
        sportType: 'esports',          // unknown → other
        matchStatus: 'MatchNotStart',
        matchTime: '1748100000000',
        thumbnail: null,
      }
    ]
  }
};

const DETAIL_FIXTURE_LIVE = {
  code: 0,
  data: {
    matchId: 'MB_S_1002',
    matchStatus: 'MatchIng',
    playPath: 'https://live-pull.aisports.mobi/live/1002_hd.m3u8',
    playSource: [
      { url: 'https://live-pull.aisports.mobi/live/1002_hd.m3u8', quality: 'HD' },
      { url: 'https://live-pull.aisports.mobi/live/1002_sd.m3u8', quality: 'SD' },
    ]
  }
};

const DETAIL_FIXTURE_PREMATCH = {
  code: 0,
  data: {
    matchId: 'MB_S_1001',
    matchStatus: 'MatchNotStart',
    playPath: 'https://live-pull.aisports.mobi/live/1001.m3u8',
    playSource: []
  }
};

describe('MovieBoxSportsProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new MovieBoxSportsProvider();
  });

  describe('Container DI', () => {
    test('resolves movieboxSportsProvider singleton', () => {
      const resolved = container.resolve('movieboxSportsProvider');
      expect(resolved).toBeInstanceOf(MovieBoxSportsProvider);
      expect(resolved.sourceName).toBe('moviebox_sports');
    });
  });

  describe('_parseAggregate', () => {
    test('maps football to football category', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const football = matches.find(m => m.id === 'MB_S_1001');
      expect(football.category).toBe('football');
      expect(football.homeTeam).toBe('Real Madrid');
      expect(football.awayTeam).toBe('Barcelona');
    });

    test('maps basketball to basketball category', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const bball = matches.find(m => m.id === 'MB_S_1002');
      expect(bball.category).toBe('basketball');
    });

    test('maps unknown sport type to "other"', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const unknown = matches.find(m => m.id === 'MB_S_1003');
      expect(unknown.category).toBe('other');
    });

    test('date is an epoch-ms string', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      const m = matches[0];
      expect(typeof m.date).toBe('string');
      expect(Number(m.date)).toBeGreaterThan(1_000_000_000_000);
    });

    test('sources array contains one entry with source = "moviebox_sports"', () => {
      const matches = provider._parseAggregate(AGGREGATE_FIXTURE.data.list);
      expect(matches[0].sources[0].source).toBe('moviebox_sports');
      expect(matches[0].sources[0].id).toBe('MB_S_1001');
    });
  });

  describe('_extractStreams', () => {
    test('returns stream array for MatchIng with proxyHeaders Referer', () => {
      const streams = provider._extractStreams(DETAIL_FIXTURE_LIVE.data);
      expect(streams.length).toBeGreaterThan(0);
      expect(streams[0].url).toMatch(/aisports\.mobi/);
      expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://sportslive.wine');
    });

    test('returns [] for MatchNotStart even with a URL present', () => {
      const streams = provider._extractStreams(DETAIL_FIXTURE_PREMATCH.data);
      expect(streams).toEqual([]);
    });

    test('returns [] when playSource is empty and status is MatchIng', () => {
      const data = { ...DETAIL_FIXTURE_LIVE.data, playSource: [], playPath: '' };
      const streams = provider._extractStreams(data);
      expect(streams).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- tests/movieboxSportsProvider.test.js`  
  Expected: FAIL — `Cannot find module '../src/providers/MovieBoxSportsProvider'`

- [ ] **Step 3: Implement `src/providers/MovieBoxSportsProvider.js`**

  Class extends `BaseProvider`. Constructor sets `this.name` and `this.sourceName = 'moviebox_sports'`.

  `_parseAggregate(list)`: map each item to a `MatchEntity` with:
  - `id: item.matchId`
  - `title: \`${item.homeTeam} vs ${item.awayTeam}\``
  - `homeTeam: item.homeTeam`
  - `awayTeam: item.awayTeam`
  - `league: item.leagueName`
  - `category: this.normalizeCategory(item.sportType)`
  - `date: String(Number(item.matchTime))` (already ms epoch from API)
  - `sources: [{ source: 'moviebox_sports', id: item.matchId }]`
  - `poster: item.thumbnail || null`

  `async getMatches()`: call `movieboxCrypto.getVisitorToken(this.proxyFetch.bind(this))`, then `makeMovieBoxRequest('/wefeed-tv-bff/sport/aggregate-v1', this.proxyFetch.bind(this), { token })`. On any error, log once and return `[]`. Call `_parseAggregate(data.list)`.

  `_extractStreams(detail)`: if `detail.matchStatus !== 'MatchIng'` return `[]`. Collect URLs from `detail.playSource` (filter truthy `.url` ending in `.m3u8`) and fall back to `detail.playPath` if array is empty. For each URL build a `StreamEntity` (or plain object) with `{ url, behaviorHints: { proxyHeaders: { request: { Referer: 'https://sportslive.wine' } } }, name: quality || 'Live' }`. Return `[]` if still empty.

  `async resolveStream(sourceId)`: call `getVisitorToken` then `makeMovieBoxRequest(\`/wefeed-tv-bff/sport/detail-v1?matchId=${sourceId}\`, ...)`. On any error return `[]`. Call `_extractStreams(data)`.

  Both network calls must pass `timeoutMs: 8000, attempts: 2` via `makeMovieBoxRequest` → `fetchFn`.

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- tests/movieboxSportsProvider.test.js`  
  Expected: All PASS

- [ ] **Step 5: Syntax-check**

  Run: `node --check src/providers/MovieBoxSportsProvider.js`  
  Expected: exits 0

- [ ] **Step 6: Commit**

  ```bash
  git add src/providers/MovieBoxSportsProvider.js tests/movieboxSportsProvider.test.js
  git commit -m "feat(moviebox): add MovieBoxSportsProvider with HLS stream extraction"
  ```

---

## Task 3: MovieBox TV Provider

**Files:**
- Create: `src/providers/MovieBoxTVProvider.js`
- Test: `tests/movieboxTVProvider.test.js`

**Interfaces:**
- Consumes: `BaseProvider`; `movieboxCrypto`; `MatchEntity`
- Produces:
  - `this.sourceName = 'moviebox_tv'`
  - `this.name = 'MovieBox TV'`
  - `async getMatches()` → `MatchEntity[]` — full channel catalog
  - `async resolveStream(sourceId, matchCategory, matchTitle, _src)` → `StreamEntity[]`

TV channel catalog strategy: Fetch the country list (145 entries) then for each country fetch page 1 of channels with `perPage: 100`. Do **not** paginate beyond page 1 — the goal is a wide first-load catalog, not exhaustive coverage. This bounds `getMatches()` to 145 + 145 upstream requests per sync cycle. Stagger with a 50 ms inter-request delay to avoid rate-limiting (`await new Promise(r => setTimeout(r, 50))` between country fetches — this is not a timer that outlives the call, so it does not violate I3).

`_parseChannel(item, countryCode)`: 
- `id: \`moviebox_tv_${item.channelId}\``
- `title: item.name || item.channelName || String(item.channelId)` — null-safe per Review Focus
- `category: 'networks'`
- `date: String(Date.now())`
- `sources: [{ source: 'moviebox_tv', id: String(item.channelId) }]`
- `league: countryCode`
- `poster: item.logo || null`

`resolveStream(sourceId)`: call `GET /wefeed-tv-bff/live/tv-channel?channelId=${sourceId}`. Extract first valid `.m3u8` URL from `data.liveUrl || data.url || data.playUrl`. Return `[{ url, behaviorHints: { proxyHeaders: { request: {} } } }]`, or `[]` if no URL found.

- [ ] **Step 1: Write failing tests**

```js
// tests/movieboxTVProvider.test.js
'use strict';
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM'); }),
  destroy: jest.fn(async () => {})
}));
jest.mock('../src/services/ProviderOutbound', () => ({
  request: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  safeFetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  fetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
}));

const MovieBoxTVProvider = require('../src/providers/MovieBoxTVProvider');
const container = require('../src/container');

const CHANNEL_LIST_FIXTURE = [
  { channelId: 'CH001', name: 'CNN International', channelName: null, logo: 'https://logo.host/cnn.png' },
  { channelId: 'CH002', name: null, channelName: null, logo: null },   // null name → fallback to channelId
  { channelId: 'CH003', name: 'BBC World News', channelName: 'BBC World', logo: 'https://logo.host/bbc.png' },
];

const TV_CHANNEL_FIXTURE = {
  code: 0,
  data: {
    channelId: 'CH001',
    liveUrl: 'https://cdn.host/CH001/live.m3u8',
  }
};

describe('MovieBoxTVProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new MovieBoxTVProvider();
  });

  describe('Container DI', () => {
    test('resolves movieboxTvProvider singleton', () => {
      const resolved = container.resolve('movieboxTvProvider');
      expect(resolved).toBeInstanceOf(MovieBoxTVProvider);
      expect(resolved.sourceName).toBe('moviebox_tv');
    });
  });

  describe('_parseChannel', () => {
    test('uses name field when present', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.title).toBe('CNN International');
    });

    test('falls back to channelId string when name and channelName are null', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[1], 'US');
      expect(entity.title).toBe('CH002');
    });

    test('category is always "networks"', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.category).toBe('networks');
    });

    test('id is prefixed with "moviebox_tv_"', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.id).toBe('moviebox_tv_CH001');
    });

    test('sources[0].source is "moviebox_tv"', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.sources[0].source).toBe('moviebox_tv');
      expect(entity.sources[0].id).toBe('CH001');
    });

    test('league is countryCode', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'GB');
      expect(entity.league).toBe('GB');
    });
  });

  describe('_extractTvStream', () => {
    test('returns stream from liveUrl field', () => {
      const streams = provider._extractTvStream(TV_CHANNEL_FIXTURE.data);
      expect(streams.length).toBe(1);
      expect(streams[0].url).toBe('https://cdn.host/CH001/live.m3u8');
    });

    test('returns [] when no URL fields are present', () => {
      const streams = provider._extractTvStream({ channelId: 'CH999' });
      expect(streams).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test -- tests/movieboxTVProvider.test.js`  
  Expected: FAIL — `Cannot find module '../src/providers/MovieBoxTVProvider'`

- [ ] **Step 3: Implement `src/providers/MovieBoxTVProvider.js`**

  Class extends `BaseProvider`. Constructor sets `this.name` and `this.sourceName = 'moviebox_tv'`.

  `_parseChannel(item, countryCode)`: as specified in Interfaces above.

  `_extractTvStream(detail)`: check `detail.liveUrl`, then `detail.url`, then `detail.playUrl`. Filter to first truthy value. Return `[{ url, behaviorHints: { proxyHeaders: { request: {} } } }]` or `[]`.

  `async getMatches()`:
  1. Get visitor token: `const token = await movieboxCrypto.getVisitorToken(this.proxyFetch.bind(this))`
  2. Fetch country list: `GET /wefeed-tv-bff/live/tv-country-list` → `data.list` (array of `{ countryCode, … }`)
  3. For each country (sequential with 50ms delay between): fetch `GET /wefeed-tv-bff/live/tv-channel-list-by-country?countryCode=${cc}&page=1&perPage=100`, map items via `_parseChannel(item, cc)`, accumulate
  4. Wrap each fetch in try/catch — log warning and continue on failure (one bad country must not abort the rest)
  5. Return flat array of all parsed entities; return `[]` on top-level failure

  `async resolveStream(sourceId)`: `GET /wefeed-tv-bff/live/tv-channel?channelId=${sourceId}` → `_extractTvStream(data)`. On error return `[]`.

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test -- tests/movieboxTVProvider.test.js`  
  Expected: All PASS

- [ ] **Step 5: Syntax-check**

  Run: `node --check src/providers/MovieBoxTVProvider.js`  
  Expected: exits 0

- [ ] **Step 6: Commit**

  ```bash
  git add src/providers/MovieBoxTVProvider.js tests/movieboxTVProvider.test.js
  git commit -m "feat(moviebox): add MovieBoxTVProvider with 145-country channel catalog"
  ```

---

## Task 4: Wire Up — DI + Aggregator + Dispatch

**Files:**
- Modify: `src/container.js` (two `require` lines + two `asClass` registrations)
- Modify: `src/services/MatchAggregator.js` (add to providers array in `syncMatches`)
- Modify: `src/streams.js` (two `else if` branches in `dispatchToProvider`)

**Interfaces:**
- Consumes: `MovieBoxSportsProvider` from Task 2; `MovieBoxTVProvider` from Task 3
- Produces: `container.resolve('movieboxSportsProvider')` and `container.resolve('movieboxTvProvider')` both return valid instances; both sources appear in `dispatchToProvider` switch

> **No new test file for this task.** The existing DI tests in Tasks 2 and 3 (`container.resolve(…)`) will now pass, and those test files already exist. The changes here are verified by re-running those two test files and then the full suite.

- [ ] **Step 1: Modify `src/container.js`**

  Add to the top `require` block (after the last existing provider `require`):
  ```js
  const MovieBoxSportsProvider = require('./providers/MovieBoxSportsProvider');
  const MovieBoxTVProvider = require('./providers/MovieBoxTVProvider');
  ```

  Add to the providers `container.register({…})` block (before the closing brace):
  ```js
  movieboxSportsProvider: asClass(MovieBoxSportsProvider).singleton(),
  movieboxTvProvider: asClass(MovieBoxTVProvider).singleton(),
  ```

- [ ] **Step 2: Modify `src/services/MatchAggregator.js` — add to provider list**

  Locate the `syncMatches()` method and the array/loop that calls `_fetchProviderMatches` on each provider. Add both new providers to the list in the same style as existing entries. The exact line to modify: search for `_fetchProviderMatches` calls or the providers array literal. Add:
  ```js
  container.resolve('movieboxSportsProvider'),
  container.resolve('movieboxTvProvider'),
  ```
  in the same position as other live providers (not replay providers).

- [ ] **Step 3: Modify `src/streams.js` — add dispatch branches**

  In `dispatchToProvider`, add before the `else if (sourceName.startsWith('yaml_'))` branch:
  ```js
  } else if (sourceName === 'moviebox_sports') {
    const provider = container.resolve('movieboxSportsProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  } else if (sourceName === 'moviebox_tv') {
    const provider = container.resolve('movieboxTvProvider');
    resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
  ```

- [ ] **Step 4: Run wiring verification**

  Run: `npm test -- tests/movieboxSportsProvider.test.js`  
  Expected: All PASS (DI test now resolves because container is wired)

  Run: `npm test -- tests/movieboxTVProvider.test.js`  
  Expected: All PASS

- [ ] **Step 5: Syntax-check all three modified files**

  ```bash
  node --check src/container.js
  node --check src/services/MatchAggregator.js
  node --check src/streams.js
  ```
  Expected: all exit 0

- [ ] **Step 6: Run full suite to catch regressions**

  Run: `npm test`  
  Expected: 284+ suites pass (count may increase by the 3 new test files); zero existing failures introduced

- [ ] **Step 7: Commit**

  ```bash
  git add src/container.js src/services/MatchAggregator.js src/streams.js
  git commit -m "feat(moviebox): wire MovieBox providers into DI, aggregator, and stream dispatch"
  ```

---

## Task 5: Build Verification

**Files:** None created or modified — build only.

**Interfaces:**
- Consumes: all files from Tasks 1–4
- Produces: `dist.next/` bundle that passes `node --check` and contains `MATCHES_CACHE_PATH`

- [ ] **Step 1: Run the staged build**

  Run: `npm run build`  
  Expected: exits 0, `dist.next/` populated, no ncc conflict errors

- [ ] **Step 2: Verify bundle integrity**

  Run: `node --check dist.next/index.js`  
  Expected: exits 0

  Run: `Select-String -Path dist.next/index.js -Pattern "MATCHES_CACHE_PATH" -Quiet`  
  Expected: `True` (deploy gate will reject the bundle otherwise)

- [ ] **Step 3: Commit**

  ```bash
  git add -A
  git commit -m "chore(moviebox): verify build passes with both MovieBox providers"
  ```

---

## Task 6: Cleanup

**Files:**
- Delete: `scripts/test_signed_req.py`
- Delete: `scripts/inspect_sport_schedule.py`
- Delete: `scripts/test_stream_quality.py`
- Delete: `scripts/probe_moviebox_all.py`
- Update: `.agents/tracks/current_task.md` with final checkpoint

> These scratch scripts served the research phase. Their knowledge is now encoded in `movieboxCrypto.js` and the two providers. Deleting them prevents them from being confused with production code.

- [ ] **Step 1: Delete scratch scripts**

  ```bash
  git rm scripts/test_signed_req.py scripts/inspect_sport_schedule.py scripts/test_stream_quality.py scripts/probe_moviebox_all.py
  ```

  If any are untracked (not committed): `Remove-Item` them manually.

- [ ] **Step 2: Write final checkpoint to `.agents/tracks/current_task.md`**

  Record: plan complete, Tasks 1–5 implemented, build green, scratch scripts removed. Note any open items (e.g. the 50ms stagger in `MovieBoxTVProvider.getMatches()` may need tuning if the 145-country sync is too slow in production — monitor via `/api/provider-health`).

- [ ] **Step 3: Commit**

  ```bash
  git add .agents/tracks/current_task.md
  git commit -m "chore(moviebox): remove research scratch scripts, write session checkpoint"
  ```
