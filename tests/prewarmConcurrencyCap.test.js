'use strict';

/**
 * Regression tests for the global prewarm concurrency cap.
 *
 * Background (measured on live VPS 2026-10-24): unbounded prewarm concurrency
 * reached 250+ simultaneous mints (each ~1.4 MB of verify scratch + socket
 * fan-out), saturating the CPU and tripping the PM2 restart ceiling every
 * ~10 minutes. The cap bounds the working set; overflow skips (never queues).
 */

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));

const origEnv = { ...process.env };

describe('prewarmMatch global concurrency cap', () => {
  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  test('PREWARM_MAX_CONCURRENT=0 gates every prewarm (no minting, no throw)', async () => {
    process.env.PREWARM_MAX_CONCURRENT = '0';
    const mod = require('../src/streams');
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await mod.prewarmMatch(
        { id: 'dlv_346_new-zealand-vs-india', category: 'cricket', sources: [{ source: 'daddylive', id: '346' }] },
        null
      );
      const minting = spy.mock.calls.filter((c) => String(c[0]).includes('[Prewarm] minting'));
      expect(minting).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('env knob is read at module load', () => {
    process.env.PREWARM_MAX_CONCURRENT = '7';
    jest.resetModules();
    const src = require('fs').readFileSync(require.resolve('../src/streams'), 'utf8');
    expect(src).toContain('process.env.PREWARM_MAX_CONCURRENT || 40');
  });

  test('channel guard still fires before the cap counter (channels never count against the cap)', async () => {
    const mod = require('../src/streams');
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) {
        await mod.prewarmMatch(
          { id: `dlv_ch_${i}_some-channel`, category: 'networks', sources: [{ source: 'daddylive', id: String(i) }] },
          null
        );
      }
      const minting = spy.mock.calls.filter((c) => String(c[0]).includes('[Prewarm] minting'));
      expect(minting).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
