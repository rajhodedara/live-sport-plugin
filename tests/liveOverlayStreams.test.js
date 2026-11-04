'use strict';

/**
 * The live overlay has exactly one observable projection point: stream
 * resolution. These tests pin that wiring, including the ordering trap that
 * would otherwise make the feature a no-op (a catalog card with no sources used
 * to short-circuit before the overlay merge).
 *
 * streams.js memoises the resolved overlay service per process, which is what we
 * want in production and exactly what must not leak between tests - so every
 * test re-requires the module graph from scratch.
 */

jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

let file;
let overlay;
let leafProvider;
let handleStream;

function boot() {
  jest.resetModules();
  const container = require('../src/container');
  const StreamResolveCache = require('../src/services/StreamResolveCache');
  const LiveOverlayService = require('../src/services/LiveOverlayService');
  ({ handleStream } = require('../src/streams'));

  file = path.join(os.tmpdir(), `nuvio-overlay-streams-${process.pid}-${Date.now()}.json`);
  overlay = new LiveOverlayService({ file });
  overlay.clear();

  leafProvider = {
    resolveStream: jest.fn(async () => [
      { name: 'Leaf', title: 'Fixture (Leaf)', externalUrl: '/watch?url=leaf-fixture' }
    ])
  };

  const match = { id: 'fixture', title: 'Fixture match', category: 'football', sources: [] };
  const services = {
    cacheService: { findMatch: () => match },
    streamResolveCache: new StreamResolveCache(),
    leafProvider,
    streamScorer: { calculateScore: () => 0 },
    m3u8Parser: null,
    liveOverlayService: overlay
  };
  container.resolve.mockImplementation((name) => services[name]);
  return { container, services, match: (next) => { services.cacheService.findMatch = () => next; } };
}

beforeEach(() => {
  process.env.DONATION_URL = 'disabled';
  boot();
});

afterEach(() => {
  try { if (file && fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
});

test('a card with no catalog sources still resolves through the overlay', async () => {
  overlay.setOverlay(new Map([['fixture', [{ source: 'leaf', id: 'live-1', name: 'Fixture match' }]]]));

  const result = await handleStream('tv', 'nuvio_sport_fixture', {});

  expect(leafProvider.resolveStream).toHaveBeenCalledTimes(1);
  expect(leafProvider.resolveStream.mock.calls[0][0]).toBe('live-1');
  expect(result.streams.some((s) => s.externalUrl === '/watch?url=leaf-fixture')).toBe(true);
});

test('without an overlay the same card yields no streams and no provider call', async () => {
  const result = await handleStream('tv', 'nuvio_sport_fixture', {});

  expect(result.streams).toEqual([]);
  expect(leafProvider.resolveStream).not.toHaveBeenCalled();
});

test('a stale catalog leaf source is replaced, not duplicated', async () => {
  const harness = boot();
  harness.match({
    id: 'fixture',
    title: 'Fixture match',
    category: 'football',
    sources: [
      { source: 'leaf', id: 'stale-0' },
      { source: 'ppvst', id: 'p1' }
    ]
  });
  overlay.setOverlay(new Map([['fixture', [{ source: 'leaf', id: 'live-1' }]]]));

  await handleStream('tv', 'nuvio_sport_fixture', {});

  const calledIds = leafProvider.resolveStream.mock.calls.map((args) => args[0]);
  expect(calledIds).toContain('live-1');
  expect(calledIds).not.toContain('stale-0');
});

test('a config that does not allow leaf still filters it out', async () => {
  overlay.setOverlay(new Map([['fixture', [{ source: 'leaf', id: 'live-1' }]]]));

  await handleStream('tv', 'nuvio_sport_fixture', { liveSources: 'ppvst' });

  expect(leafProvider.resolveStream).not.toHaveBeenCalled();
});
