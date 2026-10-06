/**
 * Regression test for the DaddyLive sync-fetch timeout baseline and its ceiling.
 *
 * History this pins down: commit f15846b (2026-09-27, "prioritize dlive.sx domain
 * and tighten schedule fetch timeouts") lowered these three fetches from
 * 12000/12000/15000 to a flat 6000 in the same commit that reordered the mirror
 * domains. The reorder was right; the timeout cut was not.
 *
 * Why 6000 broke production: this is the app's heaviest fetch (a full homepage
 * scrape plus a ~700-entry schedule JSON, across two mirrors), and every other
 * provider sits at 8000-20000ms. At 6000 DaddyLive was the ONLY provider tuned
 * to fail under load, so it alone disappeared from the catalog while every other
 * source stayed present.
 *
 * Also pins the ceiling to the circuit breaker: fetchSchedule/fetchChannels are
 * wrapped with a per-call breaker timeout, and an inner timeout at or above it is
 * silently truncated. The cap must stay below the breaker so the inner abort is
 * always the one that fires.
 *
 * Pure unit tests - no network.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src', 'providers', 'DaddyLiveProvider.js');
const source = fs.readFileSync(SRC, 'utf8');
const { BREAKER_TIMEOUT_MS } = require('../src/services/CircuitBreakerService');

/** Load resolveSyncTimeoutMs in isolation with a controllable os.loadavg + env. */
function loadHelper({ env = {}, load = 0, loadThrows = false } = {}) {
  const start = source.indexOf('function resolveSyncTimeoutMs()');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error('resolveSyncTimeoutMs not found');

  const body = source.slice(start, end + 2);
  const sandbox = {
    os: {
      loadavg: () => {
        if (loadThrows) throw new Error('loadavg unavailable');
        return [load, load, load];
      },
    },
    process: { env },
    Math,
    Number,
    console,
    BREAKER_TIMEOUT_MS,
  };
  vm.createContext(sandbox);
  vm.runInContext(body + '; this.__fn = resolveSyncTimeoutMs;', sandbox);
  return sandbox.__fn;
}

describe('baseline restored after the f15846b regression', () => {
  test('idle box uses the restored 12000ms baseline, not the 6000 regression', () => {
    expect(loadHelper({ env: {}, load: 0 })()).toBe(12000);
  });

  test('never returns below 12000, so an idle box is never worse than pre-f15846b', () => {
    for (const load of [0, 0.5, 1, 2, 4, 8]) {
      expect(loadHelper({ env: {}, load })()).toBeGreaterThanOrEqual(12000);
    }
  });

  test('adds headroom as load rises', () => {
    expect(loadHelper({ env: {}, load: 0 })()).toBe(12000);
    // load 3 -> 12000 + 6000 = 18000, still under the breaker ceiling.
    expect(loadHelper({ env: {}, load: 3 })()).toBe(12000 + 3 * 2000);
    // load 4 would be exactly the breaker ceiling, so the safety margin clamps
    // it down to 18000 - which is the whole point of the coupling.
    expect(loadHelper({ env: {}, load: 4 })()).toBe(18000);
  });

  test('the observed production load (4.94) is clamped to just under the breaker', () => {
    const v = loadHelper({ env: {}, load: 4.94 })();
    // The raw formula would give 21880, which EXCEEDS the 20s breaker and would
    // therefore be silently truncated. Both facts are pinned: the formula is what
    // drives the value, and the clamp is what makes it usable.
    expect(Math.round(12000 + 4.94 * 2000)).toBe(21880);
    expect(v).toBe(BREAKER_TIMEOUT_MS - 2000);
    expect(v).toBeLessThan(BREAKER_TIMEOUT_MS);
  });

  test('honours SYNC_TIMEOUT_BASE_MS', () => {
    expect(loadHelper({ env: { SYNC_TIMEOUT_BASE_MS: '15000' }, load: 0 })()).toBe(15000);
  });

  test('survives a loadavg that throws / is unavailable', () => {
    expect(loadHelper({ env: {}, loadThrows: true })()).toBe(12000);
  });
});

describe('ceiling is coupled to the circuit breaker, never above it', () => {
  test('huge load clamps below the breaker timeout (inner abort must win)', () => {
    const v = loadHelper({ env: {}, load: 1000 })();
    expect(v).toBeLessThan(BREAKER_TIMEOUT_MS);
  });

  test('the clamp is exactly breaker timeout minus the safety margin', () => {
    const v = loadHelper({ env: {}, load: 1000 })();
    expect(v).toBe(BREAKER_TIMEOUT_MS - 2000);
  });

  test('an explicit SYNC_TIMEOUT_MAX_MS above the breaker is still clamped down', () => {
    const v = loadHelper({ env: { SYNC_TIMEOUT_MAX_MS: '60000' }, load: 1000 })();
    expect(v).toBeLessThan(BREAKER_TIMEOUT_MS);
  });

  test('an explicit SYNC_TIMEOUT_MAX_MS below the breaker is respected', () => {
    expect(loadHelper({ env: { SYNC_TIMEOUT_MAX_MS: '13000' }, load: 9 })()).toBe(13000);
  });

  test('DADDYLIVE_SYNC_TIMEOUT_MS still overrides everything', () => {
    expect(loadHelper({ env: { DADDYLIVE_SYNC_TIMEOUT_MS: '9999' }, load: 900 })()).toBe(9999);
  });

  test('the breaker timeout is exported so this coupling cannot drift silently', () => {
    expect(typeof BREAKER_TIMEOUT_MS).toBe('number');
    expect(BREAKER_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('call sites are wired correctly', () => {
  test('exactly 3 sync fetches use the helper', () => {
    // Each sync fetch assigns its budget from the helper once, then passes the
    // same value as both signal and timeoutMs (see the attempts:1 pin below).
    expect((source.match(/= resolveSyncTimeoutMs\(\)/g) || []).length).toBe(3);
  });

  test('the 4 resolve-path fetches keep their literal 6000 (bounded by handleStream)', () => {
    expect((source.match(/AbortSignal\.timeout\(6000\)/g) || []).length).toBe(4);
  });

  test('no sync fetch was left at the flat 6000 regression value', () => {
    const ctorStart = source.indexOf('constructor(opts = {})');
    const ctorEnd = source.indexOf('clearCache(sourceId)');
    const ctor = source.slice(ctorStart, ctorEnd);
    expect(ctor).not.toMatch(/AbortSignal\.timeout\(6000\)/);
    expect((ctor.match(/= resolveSyncTimeoutMs\(\)/g) || []).length).toBe(3);
  });

  test("requires 'os' exactly once and imports the breaker timeout", () => {
    expect((source.match(/require\('os'\)/g) || []).length).toBe(1);
    expect(source).toMatch(/BREAKER_TIMEOUT_MS \} = require\('\.\.\/services\/CircuitBreakerService'\)/);
  });

  test('sync fetches forward budgetMs + attempts:1 so proxyFetch cannot substitute its own budget', () => {
    // Regression pin: proxyFetch used to drop signal/timeoutMs, silently
    // replacing this provider's tuned budget with a fixed 15s x 3 retries.
    // Every sync fetch must pass its budget as timeoutMs AND attempts: 1
    // (the mirror loop is the retry layer).
    const ctorStart = source.indexOf('constructor(opts = {})');
    const ctorEnd = source.indexOf('clearCache(sourceId)');
    const ctor = source.slice(ctorStart, ctorEnd);
    expect((ctor.match(/^\s*attempts: 1$/gm) || []).length).toBe(3);
    expect((ctor.match(/timeoutMs: (?:home)?[bB]udgetMs/g) || []).length).toBe(3);
  });
});
