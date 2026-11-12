'use strict';

// Every DamiTV resolve outcome must leave a log line that tells "never started",
// "started and failed", "started and empty" and "skipped" apart, and none of
// those lines may carry a raw error message (transport errors can include hosts,
// proxy URLs or tokens).
const DamiTvProvider = require('../src/providers/DamiTvProvider');

const SENSITIVE = 'connect ECONNREFUSED 203.0.113.9:443 via socks5://user:pw@127.0.0.1:40000 tk=SECRETTOKEN';
const CHANNEL = 'https://damitv.st/embed/?url=' + encodeURIComponent('https://damitv.st/c/foo/index.m3u8');
const make = proxyFetch => {
  const provider = new DamiTvProvider({ circuitBreaker: { wrapSync: (_name, fn) => ({ fire: fn }) } });
  provider.proxyFetch = proxyFetch;
  return provider;
};

async function capture(run) {
  const lines = [], original = {};
  for (const level of ['info', 'warn', 'log', 'error']) {
    original[level] = console[level];
    console[level] = (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  try { return { result: await run(), log: lines.join('\n') }; }
  finally { for (const level in original) console[level] = original[level]; }
}

describe('DamiTV resolve logging', () => {
  test('disabled: one explicit skip line, not one per call', async () => {
    process.env.DAMITV_ENABLED = 'false';
    try {
      const provider = make(async () => { throw new Error('must not be called'); });
      const first = await capture(() => provider.resolveStream('https://damitv.st/embed/?id=1', 'soccer', 'Fixture', {}));
      const second = await capture(() => provider.resolveStream('https://damitv.st/embed/?id=1', 'soccer', 'Fixture', {}));
      expect(first.result.length).toBe(0);
      expect(first.log).toContain('"reason":"disabled"');
      expect(second.log).toBe('');
    } finally { delete process.env.DAMITV_ENABLED; }
  });

  test('extraction answering "no sources" is logged as empty, and the fallback is not playable', async () => {
    const provider = make(async () => ({ ok: true, json: async () => ({ success: false, error: 'no sources' }) }));
    const { result, log } = await capture(() => provider.resolveStream('https://damitv.st/embed/?id=42', 'soccer', 'Fixture', {}));
    expect(log).toContain('Extraction returned no sources');
    expect(result.length).toBe(1);
    expect(result.filter(s => s.url).length).toBe(0);
  });

  test('channel token refused (HTTP 403) is logged with the status and a skip reason', async () => {
    const provider = make(async () => ({ ok: false, status: 403 }));
    const { log } = await capture(() => provider.resolveStream(CHANNEL, 'soccer', 'Fixture', {}));
    expect(log).toContain('"status":403');
    expect(log).toContain('"reason":"no_token"');
  });

  test('channel token fetch failure logs a class and code, never the raw message', async () => {
    const provider = make(async () => { throw new Error(SENSITIVE); });
    const { log } = await capture(() => provider.resolveStream(CHANNEL, 'soccer', 'Fixture', {}));
    expect(log).toContain('hls token mint failed');
    expect(log).toContain('"kind":"Error"');
    expect(log).not.toContain('SECRETTOKEN');
    expect(log).not.toContain('127.0.0.1:40000');
    expect(log).not.toContain('203.0.113.9');
  });

  test('extraction failure still logs only the sanitised phase, kind and code', async () => {
    const provider = make(async () => { throw Object.assign(new Error(SENSITIVE), { code: 'ERR_OUTBOUND_CAPACITY' }); });
    const { log } = await capture(() => provider.resolveStream('https://damitv.st/embed/?id=42', 'soccer', 'Fixture', {}));
    expect(log).toContain('ERR_OUTBOUND_CAPACITY');
    expect(log).not.toContain('SECRETTOKEN');
  });

  test('a healthy channel resolves to a playable stream with no skip or failure lines', async () => {
    const provider = make(async () => ({ ok: true, json: async () => ({ tk: 'T', e: 9999999999 }) }));
    const { result, log } = await capture(() => provider.resolveStream(CHANNEL, 'soccer', 'Fixture', {}));
    expect(result.filter(s => s.url).length).toBe(1);
    expect(log).not.toContain('skipped');
    expect(log).not.toContain('failed');
  });
});
