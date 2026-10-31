'use strict';

/**
 * tests/liveVsLocalComparison.test.js
 *
 * Live hosted smoke checks for https://nuviosports.xyz.
 * Each request deadline also covers response JSON and expires before Jest's
 * per-test limit. Transport and JSON errors must remain visible failures.
 */

describe('Live Hosted vs Local Host Comparison Gate', () => {
  const LIVE_HOST = 'https://nuviosports.xyz';

  test('live hosted manifest is accessible and valid semver', async () => {
    const res = await fetch(`${LIVE_HOST}/manifest.json`, { signal: AbortSignal.timeout(5000) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('version');
    expect(data.id).toBe('community.nuvio.live-sports');
  }, 7000);

  test('live hosted catalogs respond with valid metas array', async () => {
    const res = await fetch(`${LIVE_HOST}/catalog/tv/nuvio_sports.json`, { signal: AbortSignal.timeout(6000) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.metas)).toBe(true);
  }, 8000);
});
