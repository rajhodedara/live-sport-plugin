'use strict';

/**
 * Regression tests for the fetch-layer dead-host blocklist.
 *
 * Background (live-VPS evidence 2026-10-24): welovetocare.shop (Vavoo-family
 * out-N mirror, domain repointed to a dns.google certificate sink) and
 * ksohls.ru (DaddyLive-family embed mirror, connection refused) were fetched
 * by prewarm/verify/re-mint on every cycle. Each miss cost 3 impit attempts +
 * 1 undici fallback, a full TLS handshake to fail validation, and a multi-KB
 * certificate-dump log line. Both hosts are re-harvested from upstream pages,
 * so the block must live at the safeFetch choke point and must be treated as
 * a non-transient verdict by the shared retry policy.
 */

const { isTransientError } = require('../src/services/retry');

describe('dead-host blocklist: isDeadHost', () => {
  const { isDeadHost } = require('../src/impitClient');

  test('blocks the bare registrable domains', () => {
    expect(isDeadHost('https://welovetocare.shop/play.html#1/414')).toBe('welovetocare.shop');
    expect(isDeadHost('https://ksohls.ru/premiumtv/daddyhd.php?id=325')).toBe('ksohls.ru');
  });

  test('blocks node-prefixed mirrors (out-3.<host>, www.<host>)', () => {
    expect(isDeadHost('https://out-3.welovetocare.shop/play.html#1/155')).toBe('welovetocare.shop');
    expect(isDeadHost('https://www.ksohls.ru/daddylive.php?id=1063')).toBe('ksohls.ru');
  });

  test('does not match lookalike domains that merely end in the same labels', () => {
    expect(isDeadHost('https://welovetocare.shop.evil.com/play.html')).toBeNull();
    expect(isDeadHost('https://notksohls.ru/premiumtv/x.php')).toBeNull();
  });

  test('passes ordinary hosts, and tolerates bad input', () => {
    expect(isDeadHost('https://dlive.sx/daddylive/')).toBeNull();
    expect(isDeadHost('https://example.com')).toBeNull();
    expect(isDeadHost('')).toBeNull();
    expect(isDeadHost(null)).toBeNull();
    expect(isDeadHost('not a url')).toBeNull();
  });
});

describe('dead-host blocklist: safeFetch rejection', () => {
  const { safeFetch } = require('../src/impitClient');

  test('rejects dead hosts immediately, before any client/socket work', async () => {
    const t0 = Date.now();
    await expect(
      safeFetch('https://out-3.welovetocare.shop/play.html#1/414')
    ).rejects.toMatchObject({ code: 'ERR_DEAD_HOST', deadHost: 'welovetocare.shop' });
    // The block sits before impit selection: even ONE impit attempt would pay
    // an ~800ms retry backoff before the undici fallback. Sub-500ms proves no
    // network machinery ran.
    expect(Date.now() - t0).toBeLessThan(500);
  });

  test('the rejection is a non-transient verdict for the shared retry policy', async () => {
    let err = null;
    try {
      await safeFetch('https://ksohls.ru/premiumtv/daddyhd.php?id=325');
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(isTransientError(err)).toBe(false);
  });

  test('withRetry does not re-fire a blocked host (single execution)', async () => {
    const { withRetry } = require('../src/services/retry');
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          return safeFetch('https://out-2.welovetocare.shop/play.html#1/10');
        },
        { attempts: 3, label: 'test:dead-host' }
      )
    ).rejects.toMatchObject({ code: 'ERR_DEAD_HOST' });
    expect(calls).toBe(1);
  });
});

describe('dead-host blocklist: DEAD_HOSTS env extension', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Re-evaluate impitClient so each test reads the env at module load.
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  test('additional hosts can be blocked at deploy time without a code change', () => {
    process.env.DEAD_HOSTS = 'Hijacked-Example.com , another-dead.io';
    const { isDeadHost, safeFetch } = require('../src/impitClient');
    // Env entries are lowercased; subdomains match too.
    expect(isDeadHost('https://node.hijacked-example.com/x')).toBe('hijacked-example.com');
    expect(isDeadHost('https://another-dead.io/y')).toBe('another-dead.io');
    // Built-ins still active after env merge.
    expect(isDeadHost('https://ksohls.ru/z')).toBe('ksohls.ru');
    expect(isDeadHost('https://fine.example.org/z')).toBeNull();
    return expect(safeFetch('https://another-dead.io/y')).rejects.toMatchObject({
      code: 'ERR_DEAD_HOST',
      deadHost: 'another-dead.io',
    });
  });
});
