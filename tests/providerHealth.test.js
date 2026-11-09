'use strict';

const ProviderHealthService = require('../src/services/ProviderHealthService');

function provider(name, extras = {}) {
  return { name, getMatches: async () => [], ...extras };
}

describe('ProviderHealthService', () => {
  test('registers providers before the first sync', () => {
    const service = new ProviderHealthService();
    service.registerProviders([provider('TimStreams'), provider('DaddyLive', { sourceName: 'daddylive' })]);

    const snapshot = service.snapshot();
    expect(snapshot.providers).toHaveLength(2);
    expect(snapshot.providers.map((item) => item.id)).toEqual(['daddylive', 'timstreams']);
    expect(snapshot.providers.every((item) => item.state === 'unknown')).toBe(true);
  });

  test('records healthy, empty, degraded, and failed fetches', () => {
    const service = new ProviderHealthService();
    const healthy = provider('Healthy');
    const empty = provider('Empty');
    const degraded = provider('Degraded', { lastScheduleOk: false });
    const failed = provider('Failed');

    service.recordResult(healthy, { matches: [{ id: '1' }], durationMs: 12.6 });
    service.recordResult(empty, { matches: [], durationMs: 7 });
    service.recordResult(degraded, { matches: [{ id: '2' }], durationMs: 20 });
    service.recordResult(failed, {
      matches: [],
      durationMs: 5,
      error: new Error('GET https://provider.test/list?token=secret failed'),
    });

    const byName = Object.fromEntries(service.snapshot().providers.map((item) => [item.name, item]));
    expect(byName.Healthy).toMatchObject({ state: 'healthy', matchCount: 1, durationMs: 13, consecutiveFailures: 0 });
    expect(byName.Empty).toMatchObject({ state: 'empty', matchCount: 0, consecutiveFailures: 1 });
    expect(byName.Degraded).toMatchObject({ state: 'degraded', scheduleOk: false, consecutiveFailures: 1 });
    expect(byName.Failed.state).toBe('error');
    expect(byName.Failed.error).toContain('?[redacted]');
    expect(byName.Failed.error).not.toContain('secret');
  });

  test('tracks cached and carried-forward fixtures', () => {
    const service = new ProviderHealthService();
    const daddyLive = provider('DaddyLive', { sourceName: 'daddylive' });
    service.registerProviders([daddyLive]);
    service.recordResult(daddyLive, { matches: [], durationMs: 10 });
    service.recordCarryForward('daddylive', 4);

    expect(service.snapshot().providers[0]).toMatchObject({
      state: 'empty',
      carriedForwardCount: 4,
      note: '4 previous fixtures carried forward',
    });

    service.recordCached(daddyLive, 8, 'Fresh cache');
    expect(service.snapshot().providers[0]).toMatchObject({
      state: 'cached',
      matchCount: 8,
      note: 'Fresh cache',
    });
  });

  test('reports sync lifecycle and returns isolated snapshots', () => {
    const service = new ProviderHealthService();
    service.startSync();
    service.finishSync({ matchCount: 42, succeeded: true });

    const snapshot = service.snapshot();
    expect(snapshot.sync).toMatchObject({ state: 'complete', matchCount: 42 });
    expect(snapshot.sync.lastStartedAt).toBeTruthy();
    expect(snapshot.sync.lastCompletedAt).toBeTruthy();

    snapshot.sync.state = 'mutated';
    expect(service.snapshot().sync.state).toBe('complete');
  });
});

describe('provider health dashboard wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const home = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const configure = fs.readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  const status = fs.readFileSync(path.join(__dirname, '..', 'public', 'status.html'), 'utf8');

  test('dedicated status page fetches and renders the protected endpoint', () => {
    expect(status).toContain('id="providerHealthPanel"');
    expect(status).toContain("fetch('/api/provider-health'");
    expect(status).toContain('renderProviderHealth');
  });

  test('status page is served at /status', () => {
    expect(index).toMatch(/app\.get\('\/status'[\s\S]*?status\.html/);
  });

  test('dashboard is no longer rendered by the home or configure pages', () => {
    for (const page of [home, configure]) {
      expect(page).not.toContain('providerHealthPanel');
      expect(page).not.toContain("fetch('/api/provider-health'");
    }
  });

  test('endpoint is registered before the catch-all resolver proxy', () => {
    const endpointAt = index.indexOf("app.get('/api/provider-health'");
    const proxyAt = index.indexOf("app.use('/api', createProxyMiddleware");
    expect(endpointAt).toBeGreaterThan(-1);
    expect(endpointAt).toBeLessThan(proxyAt);
  });
});
