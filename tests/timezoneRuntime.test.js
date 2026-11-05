'use strict';

const fixture = require('./fixtures/timezone-runtime.json');
const { runRuntimeCheck } = require('../scripts/check-timezone-runtime.cjs');
const { checkDataRelease, compareVersions, VERSION_URL } = require('../scripts/check-timezone-data-release.cjs');

const control = fixture.cases.find(item => item.zone === 'America/New_York');
const runtime = { version: 'test-node', execPath: '/test/node', versions: { icu: 'test-icu', tz: 'test-tz' } };

function fixtureIntl(cases, change = parts => parts) {
  return { DateTimeFormat: class {
    constructor(_locale, options) { this.options = options; }
    resolvedOptions() { return { timeZone: 'Etc/UTC' }; }
    formatToParts(date) {
      const item = cases.find(value => value.zone === this.options.timeZone && Date.parse(value.utc) === date.getTime());
      return change(Object.entries(item.expected).map(([type, value]) => ({ type, value: String(value) })));
    }
  } };
}

describe('offline timezone runtime preflight', () => {
  test('records independent reference provenance and exact runtime', () => {
    const report = runRuntimeCheck({ intl: fixtureIntl(fixture.cases), runtime });
    expect(report.status).toBe('PASS');
    expect(report.cases).toBe(fixture.cases.length);
    expect(report.failures).toBe(0);
    expect(report.reference.version).toBe('2026f');
    expect(report.reference.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.runtime).toEqual({ node: 'test-node', execPath: '/test/node', icu: 'test-icu', tz: 'test-tz', defaultZone: 'Etc/UTC' });
  });

  test('detects a stale or incorrect rule even if the runtime version looks current', () => {
    const report = runRuntimeCheck({ cases: [control], runtime, intl: fixtureIntl([control], parts => parts.map(part => part.type === 'hour' ? { ...part, value: '14' } : part)) });
    expect(report.status).toBe('FAIL');
    expect(report.failures).toBe(1);
    expect(report.results[0].observed.hour).toBe(14);
    expect(report.action).toContain('actual PM2/container interpreter');
  });

  test('missing Intl or unsupported zones produce a structured failure', () => {
    const report = runRuntimeCheck({ cases: [control], runtime, intl: { DateTimeFormat: class { constructor() { throw new RangeError('unsupported'); } } } });
    expect(report.runtime.defaultZone).toBeNull();
    expect(report.results[0].error).toBe('UNSUPPORTED_TIMEZONE_OR_INTL');
    expect(report.status).toBe('FAIL');
  });

  test('numeric part checks reject missing fields instead of silently passing', () => {
    const intl = fixtureIntl([control], parts => parts.filter(part => part.type !== 'minute'));
    expect(runRuntimeCheck({ cases: [control], runtime, intl }).status).toBe('FAIL');
  });

  test('unchanged real seasonal controls agree with the independent oracle', () => {
    const zones = ['America/New_York', 'America/Denver', 'Europe/London', 'Europe/Paris', 'Australia/Sydney', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Pacific/Chatham', 'UTC'];
    const report = runRuntimeCheck({ cases: fixture.cases.filter(item => zones.includes(item.zone)) });
    expect(report.failures).toBe(0);
    expect(report.results.some(item => item.zone === 'Australia/Lord_Howe' && item.expected.minute === 30)).toBe(true);
  });

  test('Cuba controls preserve history and the temporary rule expiry', () => {
    const cuba = fixture.cases.filter(item => item.zone === 'America/Havana');
    expect(cuba.find(item => item.utc === '2027-01-15T20:00:00Z').expected.hour).toBe(16);
    expect(cuba.find(item => item.utc === '2027-11-08T20:00:00Z').expected.hour).toBe(15);
    expect(cuba.find(item => item.utc === '2025-11-04T20:00:00Z').expected.hour).toBe(15);
  });
});

const response = (text, ok = true) => ({ ok, text: async () => text });

describe('opt-in official IANA release monitor', () => {
  test('compares year and alphabetic release sequence', () => {
    expect(compareVersions('2026f', '2026e')).toBe(1);
    expect(compareVersions('2027a', '2026z')).toBe(1);
    expect(compareVersions('2026aa', '2026z')).toBe(1);
    expect(compareVersions('2026f', '2026f')).toBe(0);
    expect(() => compareVersions('2026f unexpected', '2026f')).toThrow();
  });

  test('matches the pinned reference without installing anything', async () => {
    const fetchImpl = jest.fn(async () => response('2026f\n'));
    expect(await checkDataRelease({ fetchImpl })).toMatchObject({ latest: '2026f', status: 'PASS' });
    expect(fetchImpl).toHaveBeenCalledWith(VERSION_URL, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
  });

  test('a new official release requires a deliberate data and fixture review', async () => {
    const report = await checkDataRelease({ fetchImpl: async () => response('2026g\n') });
    expect(report).toMatchObject({ status: 'FAIL', reason: 'NEW_IANA_RELEASE', latest: '2026g' });
    expect(report.action).toContain('No rules were installed');
  });

  test.each([
    ['2026e', 'REFERENCE_AHEAD_OF_OFFICIAL_RELEASE'],
    ['<html>failure</html>', 'INVALID_VERSION_RESPONSE'],
    ['2026f'.repeat(100), 'INVALID_VERSION_RESPONSE']
  ])('rejects %s', async (text, reason) => {
    expect(await checkDataRelease({ fetchImpl: async () => response(text) })).toMatchObject({ status: 'FAIL', reason });
  });

  test('reports HTTP and network failures without leaking request details', async () => {
    expect(await checkDataRelease({ fetchImpl: async () => response('', false) })).toMatchObject({ reason: 'IANA_HTTP_ERROR' });
    const report = await checkDataRelease({ fetchImpl: async () => { throw new Error('proxy credentials must not be printed'); } });
    expect(report.reason).toBe('IANA_CHECK_UNAVAILABLE');
    expect(JSON.stringify(report)).not.toContain('credentials');
  });

  test('aborts unread error responses before cleaning up transport resources', async () => {
    let signal;
    const fetchImpl = async (_url, options) => {
      signal = options.signal;
      return { ok: false, body: { unused: true } };
    };
    expect(await checkDataRelease({ fetchImpl })).toMatchObject({ reason: 'IANA_HTTP_ERROR' });
    expect(signal.aborted).toBe(true);
  });

  test('aborts a stalled fetch and returns a bounded timeout failure', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    expect(await checkDataRelease({ fetchImpl, timeoutMs: 5 })).toMatchObject({ status: 'FAIL', reason: 'IANA_CHECK_TIMEOUT' });
  });

  test('bounds streamed response size', async () => {
    let released = false;
    let signal;
    const fetchImpl = async (_url, options) => {
      signal = options.signal;
      return { ok: true, body: (async function* () {
        try { yield Buffer.alloc(65); } finally { released = true; }
      })() };
    };
    expect(await checkDataRelease({ fetchImpl })).toMatchObject({ reason: 'INVALID_VERSION_RESPONSE' });
    expect(released).toBe(true);
    expect(signal.aborted).toBe(true);
  });
});
