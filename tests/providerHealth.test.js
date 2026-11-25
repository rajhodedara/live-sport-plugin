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

  test('records auxiliary index health and enrichment counts', () => {
    const service = new ProviderHealthService();
    const kafka = provider('Kafka', { sourceName: 'kafka' });

    service.recordAuxiliaryResult(kafka, {
      itemCount: 12,
      durationMs: 18.7,
      note: 'Kafka sports channel index ready'
    });
    service.recordEnrichment(kafka, { enrichedFixtures: 3, totalSourcesAttached: 5 });

    expect(service.snapshot().providers[0]).toMatchObject({
      id: 'kafka',
      state: 'healthy',
      matchCount: 12,
      durationMs: 19,
      enrichedFixtures: 3,
      attachedSources: 5,
      note: 'Kafka sports channel index ready'
    });
  });

  test('accumulates Kafka event-first playback and search metrics with snapshot isolation', () => {
    const service = new ProviderHealthService();

    service.recordKafkaPlayback({
      discovered: 8,
      localHits: 3,
      sqliteHits: 2,
      upstreamSearches: 1,
      sharedSearches: 4,
      attempts: 3,
      verified: 1,
      reason: 'exhausted',
      searchStats: { requests: 1, sweepRequests: 0, shared: 4 }
    });
    service.recordKafkaPlayback({
      discovered: 9,
      localHits: 2,
      sqliteHits: 2,
      upstreamSearches: 0,
      sharedSearches: 0,
      attempts: 9,
      verified: 4,
      reason: 'complete',
      searchStats: { requests: 1, sweepRequests: 0, shared: 4 }
    });
    service.recordKafkaSearchStats({ requests: 5, sweepRequests: 4, shared: 6 });

    const snap = service.snapshot();
    const kafka = snap.providers.find((item) => item.id === 'kafka');
    expect(kafka.eventPlayback).toEqual({
      mints: 2,
      discovered: 17,
      localHits: 5,
      sqliteHits: 4,
      upstreamSearches: 1,
      sharedSearches: 4,
      attempts: 12,
      verified: 5,
      stops: { exhausted: 1, complete: 1 },
      searchTotals: { requests: 5, sweepRequests: 4, shared: 6 }
    });

    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('http');
    expect(serialized).not.toContain('manifest.json');

    snap.providers.find((item) => item.id === 'kafka').eventPlayback.stops.complete = 99;
    expect(service.snapshot().providers.find((item) => item.id === 'kafka').eventPlayback.stops.complete).toBe(1);
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

  test('dedicated status page fetches and renders the health endpoint', () => {
    expect(status).toContain('id="providerHealthPanel"');
    expect(status).toContain("fetch('/api/provider-health'");
    expect(status).toContain('renderProviderHealth');
  });

  test('status page is served at /status with its shared assets', () => {
    expect(index).toMatch(/app\.get\('\/status'[\s\S]*?status\.html/);
    for (const asset of ['status.html', 'ui.css', 'provider-icons.js']) {
      expect(fs.existsSync(path.join(__dirname, '..', 'public', asset))).toBe(true);
    }
  });

  test('response time chart does not plot cache hits as zero latency', () => {
    // recordCached reports durationMs 0, so cached providers must be filtered out.
    expect(status).toContain("Number.isFinite(p.durationMs) && p.state !== 'cached'");
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
