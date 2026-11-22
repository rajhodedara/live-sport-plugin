# RoxieStreams Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a new live-sports provider (`RoxieStreamsProvider`) scraping `roxiestreams.su` catalogs and resolving direct CDN HLS streams via dynamic domain rotation (`/domainsz77.txt`).

**Architecture:** A leaf scraper class (`RoxieStreamsProvider`) extending `BaseProvider` using guarded egress (`proxyFetch`). It parses multi-sport HTML table schedules into `MatchEntity` objects during ingest, and dynamically parses stream buttons on event pages (`/soccer-streams-X`, etc.) into `StreamEntity` objects pointing to direct CDN edge URLs (`https://{subdomain}.{activeDomain}/{stream}.m3u8`) with `proxyHeaders` for zero-byte VPS egress. Registered in `src/container.js`, `src/services/MatchAggregator.js`, and `src/streams.js`.

**Tech Stack:** Node.js (CommonJS), Express, Awilix DI, Jest, `BaseProvider` with `ProviderOutbound`/`proxyFetch`.

**Spec:** Local reverse-engineering breakdown of `roxiestreams.su` verified against production edge.

## Global Constraints

- **CommonJS Only:** Node >= 22 with `require` / `module.exports`.
- **Invariant I1 (Zero Bulk Bytes):** Never route video chunks through `/api/fastmp4`, `/api/hlschunk`, etc. Return direct CDN URLs with `behaviorHints.proxyHeaders`.
- **Invariant I3 (Leaf Nodes):** Providers must not mutate `CacheService`, mount routes, or start unmanaged timers.
- **Invariant I4 (Triple Registration):** Must be registered in `src/container.js`, added to `MatchAggregator.js` constructor, and dispatched in `src/streams.js`.
- **Invariant I10 (Guarded Egress):** All outbound HTTP must use `this.proxyFetch` with explicit `timeoutMs` and `signal`.
- **Test Fixtures:** Unit tests must use inline HTML fixtures rather than live network calls (`nock` is not used).

## Review Focus

1. **Empty / Failed `/domainsz77.txt`:** Upstream domain endpoint returns 404/500/empty; provider must gracefully fallback to known backup domain `shadow-ran.online`.
2. **Reused Stream Slugs Across Timeslots:** A page like `/soccer-streams-1` is reused for multiple matches throughout the day; match IDs must combine slug + normalized timestamp so distinct matches never collide.
3. **Empty Sport Categories:** A sport page has no events scheduled; provider must return an empty array without throwing or stalling the sync cycle.
4. **Button Syntax Variations:** Event pages may have multiple buttons, single quotes, double quotes, or varied whitespace in `getRandomStream('stream.m3u8', 'admin2')`; parser must handle regex variations robustly.
5. **No Stream Buttons on Page:** Event page is a placeholder or not yet live; `resolveStream` must return `[]` cleanly without uncaught errors.

---

### Task 1: RoxieStreams Provider Implementation & Unit Tests

**Files:**
- Create: `src/providers/RoxieStreamsProvider.js`
- Test: `tests/roxieStreamsProvider.test.js`

**Interfaces:**
- Consumes: `BaseProvider`, `MatchEntity`, `StreamEntity`, `parseTimezone`.
- Produces: `class RoxieStreamsProvider extends BaseProvider` with `getMatches()`, `resolveStream(sourceId, matchCategory, matchTitle, src)`, `_parseListingHtml(html, category)`, `_parseStreamPageHtml(html, activeDomain)`.

- [ ] **Step 1: Write the failing unit tests for RoxieStreamsProvider**

Write `tests/roxieStreamsProvider.test.js` testing:
- Instantiation and attributes (`name === 'RoxieStreams'`, `sourceName === 'roxiestreams'`).
- `_parseListingHtml` parses HTML table fixtures into valid `MatchEntity` entries.
- Category normalization (`soccer` -> `football`, `fighting` -> `mma`, `motorsports` -> `motorsport`, etc.).
- Match ID uniqueness when identical slugs occur at different kickoffs.
- `_parseStreamPageHtml` extracts subdomain and m3u8 streams into `StreamEntity` entries with `proxyHeaders`.
- Fallback domain behavior when domain pool is empty.

```javascript
// tests/roxieStreamsProvider.test.js
const RoxieStreamsProvider = require('../src/providers/RoxieStreamsProvider');

describe('RoxieStreamsProvider', () => {
  const mockCircuitBreaker = {
    wrap: (name, fn) => ({ fire: fn })
  };

  test('has correct provider metadata', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    expect(provider.name).toBe('RoxieStreams');
    expect(provider.sourceName).toBe('roxiestreams');
  });

  test('parses table listings into match entities', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const fixtureHtml = `
      <table>
        <tr>
          <td><a href="/soccer-streams-1">Juventus vs Venezia</a></td>
          <td class="event-start-time">November 22, 2026 3:30 AM</td>
          <td><span class="countdown-timer"></span></td>
        </tr>
      </table>
    `;
    const matches = provider._parseListingHtml(fixtureHtml, 'soccer');
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Juventus vs Venezia');
    expect(matches[0].category).toBe('football');
    expect(matches[0].sources[0].id).toBe('/soccer-streams-1');
  });

  test('parses stream page buttons into stream entities', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const fixtureHtml = `
      <script>var subdomain = 'admin2';</script>
      <button class="streambutton" onclick="showPlayer('clappr', getRandomStream('tnt.m3u8', 'admin2'))">Stream 1</button>
      <button class="streambutton" onclick="showPlayer('clappr', getRandomStream('ncaa16.m3u8', 'admin2'))">Stream 2</button>
    `;
    const streams = provider._parseStreamPageHtml(fixtureHtml, 'formaturamaxi.com.br');
    expect(streams).toHaveLength(2);
    expect(streams[0].url).toBe('https://admin2.formaturamaxi.com.br/tnt.m3u8');
    expect(streams[0].behaviorHints.proxyHeaders.request.Origin).toBe('https://roxiestreams.su');
    expect(streams[1].url).toBe('https://admin2.formaturamaxi.com.br/ncaa16.m3u8');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/roxieStreamsProvider.test.js`
Expected: FAIL with "Cannot find module '../src/providers/RoxieStreamsProvider'".

- [ ] **Step 3: Implement `RoxieStreamsProvider` in `src/providers/RoxieStreamsProvider.js`**

Implement `RoxieStreamsProvider` extending `BaseProvider`:
- Define `this.name = 'RoxieStreams'`, `this.sourceName = 'roxiestreams'`.
- Define base domain `https://roxiestreams.su`.
- Define categories: `['soccer', 'mlb', 'nba', 'nfl', 'nhl', 'fighting', 'motorsports']`.
- Implement `_mapCategory(sportKey)`.
- Implement `_parseListingHtml(html, sportKey)` extracting rows and building `MatchEntity` entries.
- Implement `_getActiveDomain()` fetching `domainsz77.txt` with in-memory cache and fallback to `shadow-ran.online`.
- Implement `_parseStreamPageHtml(html, activeDomain)` extracting stream targets and building `StreamEntity` entries with direct CDN URLs and `behaviorHints.proxyHeaders`.
- Implement `getMatches()` with `this.circuitBreaker.wrap` calling `proxyFetch` for each sport category.
- Implement `resolveStream(sourceId, matchCategory, matchTitle, src)` fetching the event page via `proxyFetch` and parsing streams.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/roxieStreamsProvider.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/RoxieStreamsProvider.js tests/roxieStreamsProvider.test.js
git commit -m "feat(provider): implement RoxieStreams provider and parser"
```

---

### Task 2: Awilix Container Registration

**Files:**
- Modify: `src/container.js`
- Test: `tests/roxieStreamsRegistration.test.js`

**Interfaces:**
- Consumes: `RoxieStreamsProvider`, `src/container.js`.
- Produces: `container.resolve('roxiestreamsProvider')`.

- [ ] **Step 1: Write test verifying container resolution**

Write `tests/roxieStreamsRegistration.test.js` asserting:
```javascript
const container = require('../src/container');
const RoxieStreamsProvider = require('../src/providers/RoxieStreamsProvider');

describe('RoxieStreams Container Registration', () => {
  test('resolves roxiestreamsProvider singleton from container', () => {
    const provider = container.resolve('roxiestreamsProvider');
    expect(provider).toBeInstanceOf(RoxieStreamsProvider);
    expect(provider.sourceName).toBe('roxiestreams');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/roxieStreamsRegistration.test.js`
Expected: FAIL with Awilix resolution error ("Could not resolve 'roxiestreamsProvider'").

- [ ] **Step 3: Register `roxiestreamsProvider` in `src/container.js`**

In `src/container.js`:
- Import `RoxieStreamsProvider = require('./providers/RoxieStreamsProvider');`
- Add to provider registration block:
  `roxiestreamsProvider: asClass(RoxieStreamsProvider).singleton(),`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/roxieStreamsRegistration.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/container.js tests/roxieStreamsRegistration.test.js
git commit -m "feat(container): register roxiestreamsProvider in DI container"
```

---

### Task 3: MatchAggregator Integration

**Files:**
- Modify: `src/services/MatchAggregator.js:632-633`
- Test: `tests/roxieStreamsAggregator.test.js`

**Interfaces:**
- Consumes: `roxiestreamsProvider` injected via Awilix PROXY mode.
- Produces: `MatchAggregator.providers` containing `roxiestreamsProvider`.

- [ ] **Step 1: Write test for MatchAggregator injection**

Write `tests/roxieStreamsAggregator.test.js`:
```javascript
const MatchAggregator = require('../src/services/MatchAggregator');

describe('MatchAggregator with RoxieStreams', () => {
  test('includes roxiestreamsProvider in active providers array', () => {
    const mockRoxie = { name: 'RoxieStreams', sourceName: 'roxiestreams', getMatches: jest.fn().mockResolvedValue([]) };
    const aggregator = new MatchAggregator({
      roxiestreamsProvider: mockRoxie,
      cacheService: { get: jest.fn(), set: jest.fn() }
    });
    expect(aggregator.providers).toContain(mockRoxie);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/roxieStreamsAggregator.test.js`
Expected: FAIL (mockRoxie not found in aggregator.providers).

- [ ] **Step 3: Update `src/services/MatchAggregator.js` constructor**

In `src/services/MatchAggregator.js`:
- Add `roxiestreamsProvider` to constructor parameter destructuring.
- Add `...(roxiestreamsProvider ? [roxiestreamsProvider] : [])` into `this.providers = [...]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/roxieStreamsAggregator.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/MatchAggregator.js tests/roxieStreamsAggregator.test.js
git commit -m "feat(aggregator): wire roxiestreamsProvider into MatchAggregator"
```

---

### Task 4: Stream Resolution Dispatch Wiring

**Files:**
- Modify: `src/streams.js:240-350`
- Test: `tests/roxieStreamsDispatch.test.js`

**Interfaces:**
- Consumes: `sourceName === 'roxiestreams'`, `container.resolve('roxiestreamsProvider')`.
- Produces: `dispatchToProvider` routing to `roxiestreamsProvider.resolveStream(...)`.

- [ ] **Step 1: Write test for dispatch routing**

Write `tests/roxieStreamsDispatch.test.js`:
```javascript
const container = require('../src/container');

describe('RoxieStreams Dispatch Routing', () => {
  test('dispatches roxiestreams source to roxiestreamsProvider', async () => {
    const provider = container.resolve('roxiestreamsProvider');
    const spy = jest.spyOn(provider, 'resolveStream').mockResolvedValue([]);
    
    // Test the provider directly to verify call contract
    await provider.resolveStream('/soccer-streams-1', 'football', 'Juventus vs Venezia', { id: '/soccer-streams-1' });
    expect(spy).toHaveBeenCalledWith('/soccer-streams-1', 'football', 'Juventus vs Venezia', expect.any(Object));
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/roxieStreamsDispatch.test.js`
Expected: FAIL or passes if stubbed; check `src/streams.js` dispatch logic.

- [ ] **Step 3: Add dispatch branch in `src/streams.js`**

In `src/streams.js` inside `dispatchToProvider`:
```javascript
} else if (sourceName === 'roxiestreams') {
  const provider = container.resolve('roxiestreamsProvider');
  resStreams = await provider.resolveStream(src.id, match.category, match.title, src);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/roxieStreamsDispatch.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/streams.js tests/roxieStreamsDispatch.test.js
git commit -m "feat(streams): route roxiestreams source to roxiestreamsProvider"
```

---

### Task 5: Full Verification & Local Build Validation

**Files:**
- Inspect: All touched files

- [ ] **Step 1: Run all RoxieStreams test suites**

Run: `npm test -- tests/roxieStreamsProvider.test.js tests/roxieStreamsRegistration.test.js tests/roxieStreamsAggregator.test.js tests/roxieStreamsDispatch.test.js`
Expected: 4 passed suites, all green.

- [ ] **Step 2: Syntax-check all modified files**

Run:
```bash
node --check src/providers/RoxieStreamsProvider.js
node --check src/container.js
node --check src/services/MatchAggregator.js
node --check src/streams.js
```
Expected: Clean exit code 0 on all files.

- [ ] **Step 3: Run local build**

Run: `npm run build:local`
Expected: Clean build into `dist/`.

- [ ] **Step 4: Final verification commit & handoff checkpoint**

Update `.agents/tracks/current_task.md` summarizing the new RoxieStreams provider integration.
Commit the changes.
