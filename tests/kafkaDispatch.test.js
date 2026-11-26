'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(),
  streamingFetch: jest.fn()
}));
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: () => { throw new Error('Unexpected WASM'); }
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const container = require('../src/container');
const { safeFetch, streamingFetch } = require('../src/services/ProviderOutbound');
const KafkaProvider = require('../src/providers/KafkaProvider');
const { writeCatalogFile } = require('../src/services/TrexCatalogDb');
const { TrexCatalogStore } = require('../src/services/TrexCatalogStore');
const { TrexEventSearch } = require('../src/services/TrexEventSearch');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const M3U8ParserService = require('../src/services/M3U8ParserService');
const StreamScoringService = require('../src/services/StreamScoringService');
const ProviderHealthService = require('../src/services/ProviderHealthService');
const {
  handleStream,
  selectSources,
  resolveSource,
  KNOWN_LIVE_SOURCES,
  KNOWN_FALLBACKS,
  NICE_NAMES,
  CHANNEL_TITLE_NICE_NAMES,
  SOURCE_PRIORITY
} = require('../src/streams');

describe('Kafka Stream Dispatch and Selection', () => {
  test('kafka is present in KNOWN_LIVE_SOURCES and KNOWN_FALLBACKS', () => {
    expect(KNOWN_LIVE_SOURCES).toContain('kafka');
    expect(KNOWN_FALLBACKS).toContain('kafka');
  });

  test('kafka has friendly nice names and channel title names', () => {
    expect(NICE_NAMES.kafka).toBe('Kafka');
    expect(CHANNEL_TITLE_NICE_NAMES.kafka).toBe('Kafka');
  });

  test('kafka has top-tier priority 1 in SOURCE_PRIORITY', () => {
    expect(SOURCE_PRIORITY.kafka).toBeDefined();
    expect(SOURCE_PRIORITY.kafka).toBe(1);
  });

  test('selectSources includes kafka in default fallback list and filters by liveSources config', () => {
    const matchSources = [
      { source: 'vavoo', id: 'v1' },
      { source: 'kafka', id: 'k1' },
      { source: 'daddylive', id: 'd1' }
    ];

    // Default configuration: kafka is included
    const defaultSelected = selectSources(matchSources, null);
    expect(defaultSelected.map((s) => s.source)).toContain('kafka');

    // Filtered configuration: only kafka allowed
    const kafkaOnly = selectSources(matchSources, { liveSources: 'kafka' });
    expect(kafkaOnly).toHaveLength(1);
    expect(kafkaOnly[0].source).toBe('kafka');

    // Filtered configuration: kafka excluded
    const noKafka = selectSources(matchSources, { liveSources: 'daddylive' });
    expect(noKafka.map((s) => s.source)).not.toContain('kafka');
  });

  test('dispatchToProvider routes kafka sources to kafkaProvider.resolveStream', async () => {
    const mockResolveStream = jest.fn().mockResolvedValue([
      { name: 'Kafka', title: 'Sky Sports Cricket', url: 'https://cdn.example.invalid/live.m3u8' }
    ]);

    const fakeKafkaProvider = {
      resolveStream: mockResolveStream
    };

    const originalResolve = container.resolve;
    container.resolve = jest.fn((name) => {
      if (name === 'kafkaProvider') return fakeKafkaProvider;
      return originalResolve.call(container, name);
    });

    try {
      const src = {
        source: 'kafka',
        id: 'flix:sky-cricket',
        channelName: 'Sky Sports Cricket'
      };
      const match = { id: 'm1', category: 'cricket', title: 'India vs England' };
      const controller = new AbortController();
      const opts = { signal: controller.signal };

      const res = await resolveSource(src, match, null, opts);
      expect(mockResolveStream).toHaveBeenCalledWith(
        'flix:sky-cricket',
        'cricket',
        'India vs England',
        src,
        opts
      );
      expect(res).toHaveLength(1);
      expect(res[0].url).toBe('https://cdn.example.invalid/live.m3u8');
    } finally {
      container.resolve = originalResolve;
    }
  });

  test('prepends event feeds for non-event Kafka sources and skips them for event sources', async () => {
    const eventStream = {
      name: 'Kafka',
      title: 'Event feed',
      url: 'https://cdn.example.invalid/e.m3u8',
      _source: 'kafka'
    };
    const mockResolveStream = jest.fn().mockResolvedValue([
      { name: 'Kafka', title: 'Team feed', url: 'https://cdn.example.invalid/team.m3u8' }
    ]);
    const mockResolveEventStreams = jest.fn().mockResolvedValue([eventStream]);

    const fakeKafkaProvider = {
      resolveStream: mockResolveStream,
      resolveEventStreams: mockResolveEventStreams
    };

    const originalResolve = container.resolve;
    container.resolve = jest.fn((name) => {
      if (name === 'kafkaProvider') return fakeKafkaProvider;
      return originalResolve.call(container, name);
    });

    try {
      const match = { id: 'm1', category: 'basketball', title: 'Bulls vs Cavaliers' };
      const opts = {};

      const teamRes = await resolveSource(
        { source: 'kafka', id: 'flix:team-feed', channelName: 'NBA TEAM| CHICAGO BULLS', matchMode: 'team' },
        match,
        null,
        opts
      );
      expect(mockResolveEventStreams).toHaveBeenCalledWith(match, opts);
      expect(teamRes.map((s) => s.url)).toEqual([
        'https://cdn.example.invalid/e.m3u8',
        'https://cdn.example.invalid/team.m3u8'
      ]);

      mockResolveEventStreams.mockClear();
      const eventRes = await resolveSource(
        { source: 'kafka', id: 'fx:ev', channelName: 'NEXT | Bulls vs Cavaliers', matchMode: 'event' },
        match,
        null,
        opts
      );
      expect(mockResolveEventStreams).not.toHaveBeenCalled();
      expect(eventRes.map((s) => s.url)).toEqual(['https://cdn.example.invalid/team.m3u8']);

      mockResolveEventStreams.mockClear();
      const secondRes = await resolveSource(
        { source: 'kafka', id: 'flix:team-feed-2', channelName: 'NBA TEAM| CLEVELAND CAVALIERS', matchMode: 'team' },
        match,
        null,
        opts
      );
      expect(mockResolveEventStreams).toHaveBeenCalledTimes(1);
      expect(secondRes[0].url).toBe('https://cdn.example.invalid/e.m3u8');
    } finally {
      container.resolve = originalResolve;
    }
  });

  test('compareStreams places kafka streams at the top of the list for the language tier', () => {
    const { compareStreams, parseLanguagePriority, DIRECT_STREAM_NAME } = require('../src/services/LanguagePriorityService');
    const priorities = parseLanguagePriority({});

    const daddyliveStream = {
      name: DIRECT_STREAM_NAME,
      _source: 'daddylive',
      language: 'English',
      resolution: '1080p',
      score: 110,
      speedScore: 90
    };

    const kafkaStream = {
      name: DIRECT_STREAM_NAME,
      _source: 'kafka',
      language: 'English',
      resolution: '1080p',
      score: 90,
      speedScore: 80
    };

    // Kafka stream must outrank non-Kafka stream in same language
    expect(compareStreams(kafkaStream, daddyliveStream, priorities)).toBeLessThan(0);
    expect(compareStreams(daddyliveStream, kafkaStream, priorities)).toBeGreaterThan(0);

    const sorted = [daddyliveStream, kafkaStream].sort((a, b) => compareStreams(a, b, priorities));
    expect(sorted[0]._source).toBe('kafka');
    expect(sorted[1]._source).toBe('daddylive');
  });
});

describe('handleStream event-first regression', () => {
  const KICKOFF = Date.UTC(2026, 10, 25, 3, 0);
  const NOW = KICKOFF + 57 * 60000;
  const ENV_KEYS = [
    'KAFKA_EVENT_FIRST_ENABLED',
    'KAFKA_ENABLED',
    'KAFKA_MANIFEST_URL',
    'KAFKA_EVENT_SEARCH_ENABLED',
    'KAFKA_EVENT_PROBE_CONCURRENCY',
    'KAFKA_EVENT_MAX_CANDIDATES',
    'KAFKA_EVENT_JOB_TIMEOUT_MS',
    'KAFKA_EVENT_TRACE_FIXTURE_ID',
    'KAFKA_LIVENESS_GUARD_ENABLED',
    'DONATION_URL',
    'STREAM_SOFT_DEADLINE_MS',
    'STREAM_HARD_DEADLINE_MS',
    'RESOLVE_CACHE_SHARED'
  ];
  const LIVE_PLAYLIST = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:4,\nhttps://cdn.invalid/seg12.ts\n';
  const ENDED_SEQ0_PLAYLIST = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n';
  const BASE_CHANNELS = [
    { id: 'trex:ev1', name: 'LIVE | DENVER NUGGETS - DALLAS MAVERICKS | Wed 25 Nov 03:59 CET (SE) | 8K EXCLUSIVE | SE: MAX PPV 1' },
    { id: 'trex:ev2', name: 'LIVE | DEN - NUGGETS VS DAL - MAVERICKS | Tue 24 Nov 21:00 EST (US) | 8K EXCLUSIVE | US: NBA PASS PPV 3' },
    { id: 'trex:ev3', name: 'CA (SN+ 010) | Dallas @ Denver (2026-11-24 22:00:00)' },
    { id: 'trex:label', name: 'US| NBA TV HD' },
    { id: 'trex:team', name: 'NBA TEAM| DALLAS MAVERICKS' }
  ];

  let originalResolve;
  let originalFetch;
  let savedEnv;
  let tmpDir;
  let stores;

  function buildFixture(overrides = {}) {
    return {
      id: 'dlv_event_7e46f297c8fce7363bf414f2',
      title: 'Denver Nuggets vs Dallas Mavericks',
      category: 'basketball',
      league: 'NBA',
      status: 'upcoming',
      date: String(KICKOFF),
      team1: { name: 'Denver Nuggets' },
      team2: { name: 'Dallas Mavericks' },
      sources: [
        { source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' },
        { source: 'kafka', id: 'trex:team', channelName: 'DALLAS MAVERICKS', country: 'USA', matchMode: 'team' },
        { source: 'daddylive', id: 'dl1', channelName: 'NBA TV', country: 'USA' }
      ],
      ...overrides
    };
  }

  function setupHarness({
    channels = BASE_CHANNELS,
    match = buildFixture(),
    searchMetas = [],
    searchFetch,
    playlistHandler,
    segmentHandler,
    daddyLiveStreams = [{ name: 'DaddyLive', title: 'NBA TV', url: 'https://cdn.invalid/dl1.m3u8', language: 'English', country: 'USA' }],
    healthService = new ProviderHealthService(),
    extraServices = {}
  } = {}) {
    const dbPath = path.join(tmpDir, `catalog-${stores.length}.sqlite`);
    writeCatalogFile(dbPath, channels.map(c => ({ ...c, type: 'tv' })), { generatedAt: '2026-11-25T03:00:00Z', source: 'test' });
    const catalogStore = new TrexCatalogStore({ dbPath });
    stores.push(catalogStore);

    const fetchImpl = searchFetch || jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ metas: searchMetas })
    }));
    const eventSearch = new TrexEventSearch({
      baseUrl: 'https://trex.invalid',
      fetchImpl,
      now: () => Date.now()
    });
    const kafkaProvider = new KafkaProvider({ catalogStore, eventSearch });
    const resolveCache = new StreamResolveCache({
      sharedResolver: { available: () => false, request: () => { throw new Error('unexpected L2'); } }
    });
    const m3u8Parser = new M3U8ParserService();
    const streamScorer = new StreamScoringService();
    const daddyLiveProvider = {
      resolveStream: jest.fn(async () => daddyLiveStreams)
    };

    const services = {
      cacheService: { findMatch: (id) => (id === match.id ? match : null) },
      kafkaProvider,
      daddyLiveProvider,
      streamResolveCache: resolveCache,
      m3u8Parser,
      streamScorer,
      ...(healthService !== undefined ? { providerHealthService: healthService } : {}),
      ...extraServices
    };
    container.resolve = jest.fn((name) => services[name]);

    safeFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) {
        const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\.json$/, ''));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            streams: [{
              name: '▶ Watch Live',
              title: id,
              url: `https://cdn.invalid/${id}.m3u8`
            }]
          })
        };
      }
      if (playlistHandler) return playlistHandler(target);
      if (target.includes('trex:ev1')) return { status: 502, text: async () => 'Bad Gateway' };
      if (target.includes('trex:ev2')) return { status: 200, text: async () => ENDED_SEQ0_PLAYLIST };
      return { status: 200, text: async () => LIVE_PLAYLIST };
    });

    streamingFetch.mockImplementation(async (segUrl, opts = {}) => {
      const target = String(segUrl);
      if (segmentHandler) return segmentHandler(target, opts);
      return {
        ok: true,
        status: 206,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'video/mp2t' : '1024') },
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(64) })),
              cancel: async () => {},
              releaseLock: () => {}
            };
          }
        }
      };
    });

    return { services, kafkaProvider, eventSearch, fetchImpl, resolveCache, daddyLiveProvider, healthService };
  }

  async function runWithTimers(fn, stepMs = 5000) {
    let settled = false;
    let out;
    let err;
    const promise = Promise.resolve().then(fn).then(
      (v) => { settled = true; out = v; },
      (e) => { settled = true; err = e; }
    );
    for (let i = 0; i < 10 && !settled; i += 1) {
      await jest.advanceTimersByTimeAsync(stepMs);
    }
    await promise;
    if (err) throw err;
    return out;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    originalResolve = container.resolve;
    originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, headers: { get: () => null }, body: { cancel: async () => {} } }));
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    process.env.KAFKA_ENABLED = 'true';
    process.env.KAFKA_MANIFEST_URL = 'https://trex.invalid/manifest.json';
    process.env.KAFKA_EVENT_SEARCH_ENABLED = 'true';
    process.env.KAFKA_LIVENESS_GUARD_ENABLED = 'true';
    process.env.DONATION_URL = 'disabled';
    process.env.STREAM_SOFT_DEADLINE_MS = '6000';
    process.env.STREAM_HARD_DEADLINE_MS = '15000';
    process.env.RESOLVE_CACHE_SHARED = 'false';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kafka-dispatch-'));
    stores = [];
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const store of stores) store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    container.resolve = originalResolve;
    global.fetch = originalFetch;
    safeFetch.mockReset();
    streamingFetch.mockReset();
    jest.restoreAllMocks();
    jest.useRealTimers();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('Dallas-Denver +57m: drops 502 and ended seq-0, publishes mixed event and channel feeds on cold and warm requests', async () => {
    const match = buildFixture();
    const { healthService, fetchImpl } = setupHarness({ match });

    const cold = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 200);
    expect(cold.streams.map(s => s._kafkaMatchMode).filter(Boolean)).toEqual(
      expect.arrayContaining(['event', 'label', 'team'])
    );
    expect(cold.streams.some(s => s._source === 'daddylive')).toBe(true);
    const eventRow = cold.streams.find(s => s._kafkaMatchMode === 'event');
    const labelRow = cold.streams.find(s => s._kafkaMatchMode === 'label');
    const teamRow = cold.streams.find(s => s._kafkaMatchMode === 'team');
    expect(eventRow.url).toContain(encodeURIComponent('https://cdn.invalid/trex:ev3.m3u8'));
    expect(eventRow.title).toContain('Kafka · Event');
    expect(eventRow.title).toContain('Dallas @ Denver');
    expect(labelRow.title).toContain('Kafka · Channel');
    expect(teamRow.title).toContain('Kafka · Channel');

    const kafkaHealth = healthService.snapshot().providers.find((p) => p.id === 'kafka');
    expect(kafkaHealth.eventPlayback).toMatchObject({
      mints: 1,
      discovered: 3,
      localHits: 3,
      sqliteHits: 3,
      attempts: 3,
      verified: 1,
      stops: { complete: 1 }
    });

    safeFetch.mockClear();
    fetchImpl.mockClear();

    const warm = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(warm.streams.map(s => s._kafkaMatchMode).filter(Boolean)).toEqual(
      expect.arrayContaining(['event', 'label', 'team'])
    );
    expect(warm.streams.some(s => s._source === 'daddylive')).toBe(true);
    expect(warm.streams.find(s => s._kafkaMatchMode === 'event').url).toContain(encodeURIComponent('https://cdn.invalid/trex:ev3.m3u8'));
    expect(warm.streams.find(s => s._kafkaMatchMode === 'event').title).toContain('Kafka · Event');
    expect(warm.streams.find(s => s._kafkaMatchMode === 'label').title).toContain('Kafka · Channel');
    expect(safeFetch).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('dedupes identical playback URLs preferring event while keeping eligible channels and blocked-event fallbacks', async () => {
    const match = buildFixture();
    const channels = [
      { id: 'trex:ev1', name: 'Live | Mavericks vs. Nuggets | 8K | US: PPV 1' },
      { id: 'trex:ev2', name: 'Live | Mavericks vs. Nuggets | 8K | CA: PPV 2' },
      { id: 'trex:ev3', name: 'Live | Mavericks vs. Nuggets | 8K | UK: PPV 3' },
      { id: 'trex:label', name: 'US| NBA TV HD' },
      { id: 'trex:team', name: 'NBA TEAM| DALLAS MAVERICKS' }
    ];
    setupHarness({
      match,
      channels,
      playlistHandler: async () => ({ status: 200, text: async () => LIVE_PLAYLIST })
    });

    // Make ev1, ev2, label, and team all share the identical playback URL, while ev3 is distinct.
    const prevImpl = safeFetch.getMockImplementation();
    safeFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) {
        const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\.json$/, ''));
        const mediaUrl = id === 'trex:ev3'
          ? 'https://cdn.invalid/distinct-ev3.m3u8'
          : 'https://cdn.invalid/shared-mirror.m3u8';
        return {
          ok: true,
          status: 200,
          json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: mediaUrl }] })
        };
      }
      return prevImpl(url);
    });

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    const copies = res.streams.filter((s) => s.url.includes(encodeURIComponent('https://cdn.invalid/shared-mirror.m3u8')));
    expect(copies.map(s => s._kafkaMatchMode)).toEqual(['event']);

    const eventUrls = res.streams.filter((s) => s._kafkaMatchMode === 'event').map((s) => s.url);
    expect(eventUrls).toHaveLength(2);
    expect(eventUrls.some((u) => u.includes('distinct-ev3.m3u8'))).toBe(true);
    expect(res.streams.some((s) => s._source === 'daddylive')).toBe(true);

    // A blocked event copy with the same playback URL must not suppress an eligible channel copy.
    const blockedCopyMatch = buildFixture({
      id: 'blocked-copy-ev',
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' }]
    });
    const sharedBlockedUrl = 'https://cdn.invalid/shared-blocked-check.m3u8';
    const wrappedBlockedUrl = `http://127.0.0.1:7000/api/manifest?url=${encodeURIComponent(sharedBlockedUrl)}`;
    const { resolveCache } = setupHarness({ match: blockedCopyMatch, channels: [] });
    resolveCache.getOrCreate = jest.fn(async (key) => {
      if (key.includes('fixture-events-')) {
        return [{
          name: 'Kafka',
          title: 'Blocked Event',
          url: wrappedBlockedUrl,
          clearkey: { k: 'v' },
          _source: 'kafka',
          _kafkaMatchMode: 'event'
        }];
      }
      if (key.includes('trex:label')) {
        return [{
          name: 'Kafka',
          title: 'NBA TV HD',
          url: wrappedBlockedUrl,
          _source: 'kafka',
          _kafkaMatchMode: 'label'
        }];
      }
      return [];
    });
    const blockedCopyRes = await runWithTimers(() => handleStream('tv', `nuvio_sport_${blockedCopyMatch.id}`, {}));
    expect(blockedCopyRes.streams.map(s => `${s._source}:${s._kafkaMatchMode}`)).toEqual(['kafka:label']);
    expect(blockedCopyRes.streams[0].url).toContain(encodeURIComponent(sharedBlockedUrl));
  });

  test('discovers event feeds via bounded upstream search when match has zero pre-attached Kafka sources', async () => {
    const match = buildFixture({
      sources: [{ source: 'daddylive', id: 'dl1', channelName: 'NBA TV', country: 'USA' }]
    });
    const { fetchImpl, healthService } = setupHarness({
      match,
      channels: [],
      searchMetas: [
        { id: 'trex:ev4', name: 'Live | Mavericks vs. Nuggets | all | 8K EXCLUSIVE | US: SOCCER PPV 93' },
        { id: 'trex:ev3', name: 'CA (SN+ 010) | Dallas @ Denver (2026-11-24 22:00:00)' }
      ]
    });

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(fetchImpl).toHaveBeenCalledTimes(2); // nicknames 'nuggets' (<6 hits) then 'denver nuggets'
    expect(res.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual([
      'kafka:event',
      'kafka:event',
      'daddylive:none'
    ]);

    const kafkaHealth = healthService.snapshot().providers.find((p) => p.id === 'kafka');
    expect(kafkaHealth.eventPlayback).toMatchObject({
      mints: 1,
      discovered: 2,
      sqliteHits: 0,
      upstreamSearches: 2,
      sharedSearches: 0,
      attempts: 2,
      verified: 2,
      stops: { complete: 1 },
      searchTotals: { requests: 2, sweepRequests: 0, shared: 0 }
    });
  });

  test('preserves explicit language preferences across mixed Kafka channels, events, and non-Kafka feeds', async () => {
    const match = buildFixture({
      sources: [
        { source: 'kafka', id: 'trex:label', channelName: 'NBA TV ES', country: 'Spain', language: 'Spanish', matchMode: 'label' },
        { source: 'daddylive', id: 'dl1', channelName: 'Movistar Deportes', country: 'Spain', language: 'Spanish' },
        { source: 'ppvst', id: 'p1', channelName: 'HD | NBA Pass ES', language: 'Spanish', country: 'Spain' }
      ]
    });
    const channels = [
      { id: 'trex:ev3', name: 'Live | Mavericks vs. Nuggets | all | 8K EXCLUSIVE | SE: SOCCER PPV 31' },
      { id: 'trex:label', name: 'ES| MOVISTAR DEPORTES HD' }
    ];
    setupHarness({
      match,
      channels,
      daddyLiveStreams: [{ name: 'DaddyLive', title: 'Movistar Deportes', url: 'https://cdn.invalid/dl-es.m3u8', language: 'Spanish', country: 'Spain' }],
      extraServices: {
        ppvStProvider: {
          resolveStream: jest.fn(async () => [{
            name: 'PPV.st', title: 'Mavericks vs Nuggets', url: 'https://cdn.invalid/ppv-es.m3u8', language: 'Spanish', country: 'Spain'
          }])
        }
      }
    });

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, { languages: 'Spanish' }));
    expect(res.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}:${s.language || 'none'}`)).toEqual([
      'kafka:label:Spanish',
      'ppvst:none:Spanish',
      'daddylive:none:Spanish',
      'kafka:event:none'
    ]);
  });

  test('performs zero Kafka requests when Kafka is disabled', async () => {
    process.env.KAFKA_ENABLED = 'false';
    const match = buildFixture();
    const { fetchImpl } = setupHarness({ match });

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(safeFetch.mock.calls.some(([url]) => String(url).includes('/stream/tv/'))).toBe(false);
    expect(res.streams.map((s) => s._source)).toEqual(['daddylive']);
  });

  test('returns ready Kafka channel at soft deadline while stalled event probe completes later, and handles slow channel + quick event', async () => {
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';
    const match = buildFixture();
    let releaseSlowEvent;
    const slowEvent = new Promise((r) => { releaseSlowEvent = r; });

    setupHarness({
      match,
      channels: [
        { id: 'trex:ev1', name: 'Live | Mavericks vs. Nuggets | all | 8K EXCLUSIVE | US: PPV 1' },
        { id: 'trex:label', name: 'US| NBA TV HD' },
        { id: 'trex:team', name: 'NBA TEAM| DALLAS MAVERICKS' }
      ],
      playlistHandler: async (target) => {
        if (target.includes('trex:ev1')) {
          await slowEvent;
        }
        return { status: 200, text: async () => LIVE_PLAYLIST };
      }
    });

    let response;
    const req = handleStream('tv', `nuvio_sport_${match.id}`, {}).then((val) => { response = val; });
    await jest.advanceTimersByTimeAsync(110);
    await req;

    expect(response).toBeDefined();
    expect(response.cacheMaxAge).toBe(2);
    expect(response.streams).toContainEqual(expect.objectContaining({ _kafkaMatchMode: 'label' }));
    const initialSnapshot = response.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`);
    expect(initialSnapshot).not.toContain('kafka:event');

    releaseSlowEvent();
    await jest.advanceTimersByTimeAsync(2100);
    const refreshed = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(refreshed.streams.map(s => s._kafkaMatchMode).filter(Boolean)).toEqual(
      expect.arrayContaining(['event', 'label', 'team'])
    );
    expect(refreshed.cacheMaxAge).toBe(30);
    // Original response remains unchanged after late event arrival.
    expect(response.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual(initialSnapshot);

    // Reversed case: slow channel and quick event.
    const slowChanMatch = buildFixture({
      id: 'slow-chan-ev',
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' }]
    });
    let releaseSlowChan;
    const slowChan = new Promise((r) => { releaseSlowChan = r; });
    setupHarness({
      match: slowChanMatch,
      channels: [
        { id: 'trex:ev1', name: 'Live | Mavericks vs. Nuggets | all | 8K EXCLUSIVE | US: PPV 1' },
        { id: 'trex:label', name: 'US| NBA TV HD' }
      ],
      playlistHandler: async (target) => {
        if (target.includes('trex:label')) {
          await slowChan;
        }
        return { status: 200, text: async () => LIVE_PLAYLIST };
      }
    });

    let revResponse;
    const revReq = handleStream('tv', `nuvio_sport_${slowChanMatch.id}`, {}).then((val) => { revResponse = val; });
    await jest.advanceTimersByTimeAsync(110);
    await revReq;

    expect(revResponse).toBeDefined();
    expect(revResponse.cacheMaxAge).toBe(2);
    expect(revResponse.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual(['kafka:event']);

    releaseSlowChan();
    await jest.advanceTimersByTimeAsync(2100);
    const revRefreshed = await runWithTimers(() => handleStream('tv', `nuvio_sport_${slowChanMatch.id}`, {}));
    expect(revRefreshed.streams.map(s => s._kafkaMatchMode).filter(Boolean)).toEqual(
      expect.arrayContaining(['event', 'label'])
    );
    expect(revRefreshed.cacheMaxAge).toBe(30);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('waits to hard deadline when no ready Kafka row exists and event discovery stalls', async () => {
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';
    const match = buildFixture({
      id: 'no-kafka-ready',
      sources: [{ source: 'daddylive', id: 'dl1', channelName: 'NBA TV', country: 'USA' }]
    });
    const { healthService } = setupHarness({
      match,
      channels: [{ id: 'trex:ev1', name: 'Live | Mavericks vs. Nuggets | all | 8K EXCLUSIVE | US: PPV 1' }],
      playlistHandler: async (target) => {
        if (target.includes('trex:ev1')) return new Promise(() => {});
        return { status: 200, text: async () => LIVE_PLAYLIST };
      }
    });

    let response;
    const req = handleStream('tv', `nuvio_sport_${match.id}`, {}).then((val) => { response = val; });
    await jest.advanceTimersByTimeAsync(110);
    expect(response).toBeUndefined();
    await jest.advanceTimersByTimeAsync(90);
    await req;

    expect(response).toBeDefined();
    expect(response.cacheMaxAge).toBe(2);
    expect(response.streams.map((s) => s._source)).toEqual(['daddylive']);
    const kafkaHealth = healthService.snapshot().providers.find((p) => p.id === 'kafka');
    expect(kafkaHealth.eventPlayback.stops.deadline).toBe(1);
    await jest.advanceTimersByTimeAsync(20000);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('verifies candidates across fixtures with configured concurrency 4, keeps multiple URLs per candidate, dedupes viewers, and releases slots on errors', async () => {
    process.env.KAFKA_EVENT_PROBE_CONCURRENCY = '4';
    const matches = [
      buildFixture({ id: 'multi-1', title: 'Denver Nuggets vs Dallas Mavericks', team1: { name: 'Denver Nuggets' }, team2: { name: 'Dallas Mavericks' }, sources: [] }),
      buildFixture({ id: 'multi-2', title: 'Boston Celtics vs Miami Heat', team1: { name: 'Boston Celtics' }, team2: { name: 'Miami Heat' }, sources: [] }),
      buildFixture({ id: 'multi-3', title: 'Los Angeles Lakers vs Golden State Warriors', team1: { name: 'Los Angeles Lakers' }, team2: { name: 'Golden State Warriors' }, sources: [] })
    ];
    const fixtureCandidates = new Map([
      ['multi-1', [
        { id: 'trex:m1-err', name: 'Live | Nuggets vs Mavericks | US: PPV 1' },
        { id: 'trex:m1-seq0', name: 'Live | Nuggets vs Mavericks | US: PPV 2' },
        { id: 'trex:m1-ok', name: 'Live | Nuggets vs Mavericks | US: PPV 3' },
        { id: 'trex:m1-multi', name: 'Live | Nuggets vs Mavericks | US: PPV 4' }
      ]],
      ['multi-2', [
        { id: 'trex:m2-dup', name: 'Live | Celtics vs Heat | US: PPV 5' },
        { id: 'trex:m2-ck', name: 'Live | Celtics vs Heat | US: PPV 6' },
        { id: 'trex:m2-ok1', name: 'Live | Celtics vs Heat | US: PPV 7' },
        { id: 'trex:m2-ok2', name: 'Live | Celtics vs Heat | US: PPV 8' }
      ]],
      ['multi-3', [
        { id: 'trex:m3-ok1', name: 'Live | Lakers vs Warriors | US: PPV 9' },
        { id: 'trex:m3-ok2', name: 'Live | Lakers vs Warriors | US: PPV 10' },
        { id: 'trex:m3-ok3', name: 'Live | Lakers vs Warriors | US: PPV 11' }
      ]]
    ]);
    const uniqueCandidateCount = [...fixtureCandidates.values()].reduce((sum, list) => sum + list.length, 0);

    let activeProbes = 0;
    let peakActive = 0;
    let candidateAttempts = 0;
    const kafkaProvider = new KafkaProvider({
      catalogStore: {
        isReady: () => true,
        findEvents: (m) => fixtureCandidates.get(m.id) || [],
        findChannel: () => [],
        findTeam: () => []
      },
      eventSearch: { cachedFor: () => [], findForFixture: async () => [], isInWindow: () => true }
    });
    const resolveCache = new StreamResolveCache({
      sharedResolver: { available: () => false, request: () => { throw new Error('unexpected L2'); } }
    });
    const services = {
      cacheService: { findMatch: (id) => matches.find(m => m.id === id) || null },
      kafkaProvider,
      streamResolveCache: resolveCache,
      m3u8Parser: new M3U8ParserService(),
      streamScorer: new StreamScoringService()
    };
    container.resolve = jest.fn((name) => services[name]);

    safeFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) {
        const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\.json$/, ''));
        candidateAttempts += 1;
        activeProbes += 1;
        peakActive = Math.max(peakActive, activeProbes);
        await new Promise((r) => setTimeout(r, 15));
        activeProbes -= 1;
        if (id === 'trex:m1-err') return { ok: false, status: 404, statusText: 'Not Found' };
        if (id === 'trex:m1-multi') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              streams: [
                { name: '▶ Watch Live', title: `${id} mirror A`, url: 'https://cdn.invalid/m1-a.m3u8' },
                { name: '▶ Watch Live', title: `${id} mirror B`, url: 'https://cdn.invalid/m1-b.m3u8' }
              ]
            })
          };
        }
        if (id === 'trex:m2-dup') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: 'https://cdn.invalid/trex:m2-ok1.m3u8' }] })
          };
        }
        if (id === 'trex:m2-ck') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: 'https://cdn.invalid/m2.mpd', clearkey: { k: 'v' } }] })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: `https://cdn.invalid/${id}.m3u8` }] })
        };
      }
      if (target.includes('m1-seq0.m3u8')) {
        return { status: 200, text: async () => ENDED_SEQ0_PLAYLIST };
      }
      return { status: 200, text: async () => LIVE_PLAYLIST };
    });
    streamingFetch.mockResolvedValue({
      ok: true,
      status: 206,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'video/mp2t' : '1024') },
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(64) })),
            cancel: async () => {},
            releaseLock: () => {}
          };
        }
      }
    });

    const viewerRequests = [];
    for (let i = 0; i < 21; i += 1) {
      const m = matches[i % matches.length];
      viewerRequests.push(handleStream('tv', `nuvio_sport_${m.id}`, {}));
    }
    const responses = await runWithTimers(() => Promise.all(viewerRequests));

    expect(peakActive).toBe(4);
    expect(candidateAttempts).toBe(uniqueCandidateCount);

    const m1Urls = responses[0].streams.map(s => s.url);
    expect(m1Urls).toHaveLength(3);
    for (const u of ['trex%3Am1-ok.m3u8', 'm1-a.m3u8', 'm1-b.m3u8']) {
      expect(m1Urls.some(url => url.includes(u))).toBe(true);
    }
    const m2Urls = responses[1].streams.map(s => s.url);
    expect(m2Urls).toHaveLength(2);
    for (const u of ['trex%3Am2-ok1.m3u8', 'trex%3Am2-ok2.m3u8']) {
      expect(m2Urls.some(url => url.includes(u))).toBe(true);
    }
    const m3Urls = responses[2].streams.map(s => s.url);
    expect(m3Urls).toHaveLength(3);
    for (const u of ['trex%3Am3-ok1.m3u8', 'trex%3Am3-ok2.m3u8', 'trex%3Am3-ok3.m3u8']) {
      expect(m3Urls.some(url => url.includes(u))).toBe(true);
    }

    safeFetch.mockClear();
    const warm = await runWithTimers(() => handleStream('tv', `nuvio_sport_${matches[0].id}`, {}));
    expect(warm.streams).toHaveLength(3);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('throwing metrics recorder cannot prevent verified event playback', async () => {
    const match = buildFixture({ sources: [] });
    setupHarness({
      match,
      healthService: {
        recordKafkaPlayback: () => { throw new Error('metrics store full'); }
      }
    });

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(res.streams).toHaveLength(1);
    expect(res.streams[0]._source).toBe('kafka');
    expect(res.streams[0]._kafkaMatchMode).toBe('event');
    expect(res.streams[0].url).toContain(encodeURIComponent('https://cdn.invalid/trex:ev3.m3u8'));
  });

  test('restores legacy behavior when KAFKA_EVENT_FIRST_ENABLED=false', async () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'false';
    const match = buildFixture();
    const { kafkaProvider, daddyLiveProvider } = setupHarness({ match });
    const spyResolveEvents = jest.spyOn(kafkaProvider, 'resolveEventStreams');

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(spyResolveEvents).toHaveBeenCalled();
    expect(daddyLiveProvider.resolveStream).toHaveBeenCalled();
    expect(res.streams.some((s) => s._source === 'kafka')).toBe(true);
    expect(res.streams.every((s) => s._kafkaMatchMode === undefined)).toBe(true);
  });

  test('resolves live UCL soccer fixture via SQLite x/STAN events and publishes mixed event, channel, and non-Kafka feeds', async () => {
    const soccerKickoff = Date.UTC(2026, 10, 25, 19, 45);
    const soccerNow = soccerKickoff + 57 * 60000;
    jest.setSystemTime(soccerNow);
    const baseMatch = buildFixture({
      id: 'ucl-inter-vfb',
      title: 'Internazionale vs VfB Stuttgart',
      category: 'football',
      league: 'UCL',
      date: String(soccerKickoff),
      team1: { name: 'Inter' },
      team2: { name: 'VfB Stuttgart' },
      sources: [
        { source: 'daddylive', id: 'dl1', channelName: 'TNT Sports 1', country: 'UK' },
        { source: 'scorezone', id: 'sz_iptv_gb-tnt1', canonicalChannel: 'TNT Sports 1', country: 'UK' },
        { source: 'scorezone', id: 'eyJoIjoiSW50ZXIiLCJhIjoiU3R1dHRnYXJ0In0.sig' },
        { source: 'ppvst', id: 99, channelName: 'HD | Champions League' }
      ]
    });

    const { kafkaProvider } = setupHarness({
      match: baseMatch,
      channels: [
        { id: 'trex:ev1', name: 'AU (STAN 23) | Internazionale v Stuttgart  UEFA Champions League Matchday 5 2026/2027 (2026-11-26 06:55:50)' },
        { id: 'trex:ev2', name: 'NEXT | INTER DE MILÃO X STUTTGART | Wed 25 Nov 17:45 -02 (BR) | 8K EXCLUSIVE | BR: MAX PPV 9' },
        { id: 'trex:u19', name: 'Next | Inter U19 vs Stuttgart U19 | UEFA Youth League | 2026-11-25 | 13:00 (GMT)' },
        { id: 'trex:tv-inter', name: 'UA| INTER' },
        { id: 'trex:team', name: 'SERIE A| INTER MILAN' },
        { id: 'trex:label', name: 'UK| TNT SPORTS 1 FHD' }
      ],
      playlistHandler: async (target) => (
        target.includes('trex:ev1')
          ? { status: 502, text: async () => 'Bad Gateway' }
          : { status: 200, text: async () => LIVE_PLAYLIST }
      ),
      extraServices: {
        scorezoneProvider: {
          resolveStream: jest.fn(async (id) => ([{
            name: 'ScoreZone',
            title: id.startsWith('sz_iptv_') ? 'TNT Sports 1' : 'Inter vs Stuttgart',
            canonicalChannel: id.startsWith('sz_iptv_') ? 'TNT Sports 1' : undefined,
            url: `https://cdn.invalid/${id}.m3u8`
          }]))
        },
        ppvStProvider: {
          resolveStream: jest.fn(async () => ([{
            name: 'PPV.st', title: 'HD | Champions League', url: 'https://cdn.invalid/ppv-ucl.m3u8'
          }]))
        }
      }
    });

    const syncedKafkaSources = kafkaProvider.createSourcesForFixture(baseMatch, { now: soccerNow });
    expect(syncedKafkaSources.map((s) => `${s.id}:${s.matchMode}`)).toEqual([
      'trex:ev1:event',
      'trex:ev2:event',
      'trex:label:label',
      'trex:team:team'
    ]);
    baseMatch.sources.push(...syncedKafkaSources);

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${baseMatch.id}`, {}));
    const keys = res.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`);
    expect(keys).toContain('kafka:event');
    expect(keys).toContain('kafka:label');
    expect(keys).toContain('kafka:team');
    expect(keys).toContain('ppvst:none');
    expect(keys).toContain('scorezone:none');
    expect(keys).toContain('daddylive:none');
    expect(res.streams.some((s) => s.url.includes('sz_iptv_gb-tnt1'))).toBe(true);
    expect(res.streams.some((s) => s.url.includes('eyJoIjoiSW50ZXIiLCJhIjoiU3R1dHRnYXJ0In0.sig'))).toBe(true);
    expect(res.streams.some((s) => s.url.includes('trex:u19'))).toBe(false);
    expect(res.streams.some((s) => s.url.includes('trex:tv-inter'))).toBe(false);
  });

  test('keeps channel fallbacks when all event feeds fail/block, Kafka is excluded, or card is replay/24-7', async () => {
    const blockedMatch = buildFixture({ id: 'blocked-ev' });
    setupHarness({
      match: blockedMatch,
      channels: [
        { id: 'trex:ev1', name: 'Live | Mavericks vs. Nuggets | 8K | US: PPV 1' },
        { id: 'trex:label', name: 'US| NBA TV HD' }
      ]
    });
    const prevImpl = safeFetch.getMockImplementation();
    safeFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/stream/tv/trex%3Aev1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ streams: [{ name: '▶ Watch Live', url: 'https://cdn.invalid/ev1.mpd', clearkey: { k: 'v' } }] })
        };
      }
      return prevImpl(url);
    });
    const blockedRes = await runWithTimers(() => handleStream('tv', `nuvio_sport_${blockedMatch.id}`, {}));
    expect(blockedRes.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual(['kafka:label', 'kafka:team', 'daddylive:none']);

    // User excluded Kafka -> daddylive channel stays
    const noKafka = await runWithTimers(() => handleStream('tv', `nuvio_sport_${blockedMatch.id}`, { liveSources: 'daddylive' }));
    expect(noKafka.streams.map((s) => s._source)).toEqual(['daddylive']);

    // Standalone 24/7 TV channel card keeps channel feeds and existing title formatting
    const chCard = buildFixture({
      id: 'dlv_ch_123_nbatv',
      title: 'NBA TV',
      category: 'networks',
      date: '0',
      team1: null,
      team2: null,
      sources: [
        { source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' },
        { source: 'daddylive', id: 'dl1', channelName: 'NBA TV' }
      ]
    });
    setupHarness({ match: chCard, channels: [{ id: 'trex:label', name: 'US| NBA TV HD' }] });
    const chRes = await runWithTimers(() => handleStream('tv', `nuvio_sport_${chCard.id}`, {}));
    expect(chRes.streams.map((s) => s._source)).toEqual(['kafka', 'daddylive']);
    expect(chRes.streams[0].title).toContain('Kafka |');
    expect(chRes.streams[0].title).not.toContain('Kafka ·');
  });

  test('publishes fast verified event and ready channel at soft deadline while slow probe completes in background', async () => {
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '5000';
    const match = buildFixture({ id: 'slow-bg-ev' });
    let resolveSlowProbe;
    const slowProbe = new Promise((r) => { resolveSlowProbe = r; });

    setupHarness({
      match,
      channels: [
        { id: 'trex:fast', name: 'Live | Mavericks vs. Nuggets | 8K | US: PPV 1' },
        { id: 'trex:slow', name: 'Live | Mavericks vs. Nuggets | 8K | US: PPV 2' },
        { id: 'trex:label', name: 'US| NBA TV HD' }
      ]
    });

    const baseSafeFetch = safeFetch.getMockImplementation();
    const resolveCalls = [];
    safeFetch.mockImplementation(async (url, ...rest) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) resolveCalls.push(target);
      if (target.includes('/stream/tv/trex%3Aslow')) {
        await slowProbe;
      }
      return baseSafeFetch(url, ...rest);
    });

    let firstRes;
    const firstPromise = handleStream('tv', `nuvio_sport_${match.id}`, {}).then((v) => { firstRes = v; });
    await jest.advanceTimersByTimeAsync(110);
    await firstPromise;

    expect(firstRes).toBeDefined();
    expect(firstRes.cacheMaxAge).toBe(2);
    expect(firstRes.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual([
      'kafka:event',
      'kafka:label',
      'kafka:team',
      'daddylive:none'
    ]);
    expect(firstRes.streams[0].url).toContain('trex%3Afast');

    // Complete slow probe after initial response and advance past partial TTL.
    resolveSlowProbe();
    await jest.advanceTimersByTimeAsync(2100);

    const secondRes = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(secondRes.cacheMaxAge).toBe(30);
    expect(secondRes.streams.map((s) => `${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual([
      'kafka:event',
      'kafka:event',
      'kafka:label',
      'kafka:team',
      'daddylive:none'
    ]);
    expect(secondRes.streams.some((s) => s.url.includes('trex%3Afast'))).toBe(true);
    expect(secondRes.streams.some((s) => s.url.includes('trex%3Aslow'))).toBe(true);
    expect(resolveCalls.filter((u) => u.includes('trex%3Afast'))).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('ranks 1080p broadcaster ahead of 720p-probed 8K-titled event and below-group team feed on cold and warm responses', async () => {
    const match = buildFixture({
      id: 'quality-rank-ev',
      sources: [
        { source: 'kafka', id: 'trex:team', channelName: 'DALLAS MAVERICKS', country: 'USA', matchMode: 'team' },
        { source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' }
      ]
    });
    const channels = [
      { id: 'trex:ev-8k', name: 'US (PPV 1) | Denver Nuggets vs Dallas Mavericks | 8K EXCLUSIVE' },
      { id: 'trex:label', name: 'US| NBA TV HD' },
      { id: 'trex:team', name: 'NBA TEAM| DALLAS MAVERICKS' }
    ];
    setupHarness({
      match,
      channels,
      playlistHandler: async (target) => {
        if (target.includes('trex:label')) {
          return {
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\n1080p.m3u8\n'
          };
        }
        if (target.includes('trex:team')) {
          return {
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160\n2160p.m3u8\n'
          };
        }
        if (target.includes('trex:ev-8k')) {
          return {
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720\n720p.m3u8\n'
          };
        }
        return { status: 200, text: async () => LIVE_PLAYLIST };
      }
    });

    const cold = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 200);
    expect(cold.streams.map((s) => `${s._kafkaMatchMode}:${s.title.split('\n')[0].includes('Kafka · Event') ? 'Event' : 'Channel'}`)).toEqual([
      'label:Channel',
      'event:Event',
      'team:Channel'
    ]);
    expect(cold.streams[0].title).toContain('Kafka · Channel');
    expect(cold.streams[1].title).toContain('Kafka · Event');

    safeFetch.mockClear();
    const warm = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(warm.streams.map((s) => `${s._kafkaMatchMode}:${s.title.split('\n')[0].includes('Kafka · Event') ? 'Event' : 'Channel'}`)).toEqual([
      'label:Channel',
      'event:Event',
      'team:Channel'
    ]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  test('ranks bitrate-probed 1080p broadcaster ahead of bitrate-probed 720p 8K-claimed event on cold and warm responses', async () => {
    const match = buildFixture({
      id: 'bitrate-rank-ev',
      sources: [
        { source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' }
      ]
    });
    const channels = [
      { id: 'trex:ev-8k', name: 'US (PPV 1) | Denver Nuggets vs Dallas Mavericks | 8K EXCLUSIVE' },
      { id: 'trex:label', name: 'US| NBA TV HD' }
    ];
    setupHarness({
      match,
      channels,
      playlistHandler: async (target) => {
        const tag = target.includes('trex:label') ? 'chan1080' : 'ev720';
        return {
          status: 200,
          text: async () => `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:10.0,\nhttps://cdn.invalid/seg-${tag}.ts\n`
        };
      }
    });
    global.fetch.mockImplementation(async (segUrl) => {
      const is1080 = String(segUrl).includes('seg-chan1080');
      const bytes = is1080 ? 5625000 : 3125000; // 4.5 Mbps (1080p) vs 2.5 Mbps (720p) over 10s
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (String(h).toLowerCase() === 'content-length' ? String(bytes) : null) },
        body: { cancel: async () => {} }
      };
    });

    const cold = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 200);
    expect(cold.streams.map(s => s._kafkaMatchMode)).toEqual(['label', 'event']);
    expect(cold.streams[0].title).toContain('Kafka · Channel');
    expect(cold.streams[0].title).toContain('1080p · 4.5 Mbps');
    expect(cold.streams[1].title).toContain('Kafka · Event');
    expect(cold.streams[1].title).toContain('720p · 2.5 Mbps');

    safeFetch.mockClear();
    global.fetch.mockClear();
    const warm = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(warm.streams.map(s => s._kafkaMatchMode)).toEqual(['label', 'event']);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('retries temporary NHL 11 failure after first-attempt queue within 4 slots while keeping definitive rejections at 1 attempt and emitting safe trace', async () => {
    process.env.KAFKA_EVENT_PROBE_CONCURRENCY = '4';
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';
    const match = buildFixture({
      id: 'nhl-recovery-ev',
      title: 'Utah Mammoth vs Minnesota Wild',
      category: 'hockey',
      league: 'NHL',
      team1: { name: 'Utah Mammoth' },
      team2: { name: 'Minnesota Wild' },
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NHL Network', country: 'USA', matchMode: 'label' }]
    });
    process.env.KAFKA_EVENT_TRACE_FIXTURE_ID = match.id;

    const channels = [
      { id: 'trex:836411', name: 'Live | Utah Mammoth vs Minnesota Wild | US: NHL 11', score: 9500 },
      { id: 'trex:ended', name: 'Live | Utah Mammoth vs Minnesota Wild | US: ENDED', score: 9400 },
      { id: 'trex:policy', name: 'Live | Utah Mammoth vs Minnesota Wild | US: POLICY', score: 9300 },
      { id: 'trex:slow1', name: 'Live | Utah Mammoth vs Minnesota Wild | US: SLOW 1', score: 9200 },
      { id: 'trex:slow2', name: 'Live | Utah Mammoth vs Minnesota Wild | US: SLOW 2', score: 9100 },
      { id: 'trex:slow3', name: 'Live | Utah Mammoth vs Minnesota Wild | US: SLOW 3', score: 9000 },
      { id: 'trex:slow4', name: 'Live | Utah Mammoth vs Minnesota Wild | US: SLOW 4', score: 8900 },
      { id: 'trex:label', name: 'US| NHL NETWORK HD' }
    ];

    const traceLogs = [];
    const infoSpy = jest.spyOn(console, 'info').mockImplementation((...args) => {
      if (String(args[0]).includes('[KafkaEventTrace]')) traceLogs.push(String(args.join(' ')));
    });

    const probeCallOrder = [];
    let activeSlots = 0;
    let peakActive = 0;
    let nhl11Attempts = 0;
    let endedAttempts = 0;
    let policyAttempts = 0;
    let releaseSlow;
    const slowGate = new Promise((r) => { releaseSlow = r; });

    const { kafkaProvider } = setupHarness({
      match,
      channels,
      playlistHandler: async (target) => {
        if (target.includes('trex:ended')) {
          return { status: 200, text: async () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST\n' };
        }
        return { status: 200, text: async () => LIVE_PLAYLIST };
      }
    });

    const baseWithEventProbe = kafkaProvider.withEventProbe.bind(kafkaProvider);
    kafkaProvider.withEventProbe = (fn, sig) => baseWithEventProbe(async () => {
      activeSlots += 1;
      peakActive = Math.max(peakActive, activeSlots);
      try {
        return await fn();
      } finally {
        activeSlots -= 1;
      }
    }, sig);

    const prevSafeFetch = safeFetch.getMockImplementation();
    safeFetch.mockImplementation(async (url, opts) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) {
        const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\.json$/, ''));
        probeCallOrder.push(id);
        if (id === 'trex:836411') {
          nhl11Attempts += 1;
          if (nhl11Attempts <= 2) {
            throw Object.assign(new Error('secret-token-should-not-leak: upstream timed out'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              streams: [{
                name: '▶ Watch Live',
                title: id,
                url: 'https://cdn.invalid/nhl11-recovered.m3u8?token=SECRET_TOKEN_XYZ',
                behaviorHints: { proxyHeaders: { request: { Referer: 'https://secret.header/' } } }
              }]
            })
          };
        }
        if (id === 'trex:ended') endedAttempts += 1;
        if (id === 'trex:policy') {
          policyAttempts += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({ streams: [{ name: '▶ Watch Live', url: 'https://cdn.invalid/ck.mpd', clearkey: { k: 'v' } }] })
          };
        }
        if (id.startsWith('trex:slow')) {
          await slowGate;
        }
      }
      return prevSafeFetch(url, opts);
    });

    try {
      let firstRes;
      const firstPromise = handleStream('tv', `nuvio_sport_${match.id}`, {}).then((v) => { firstRes = v; });
      await jest.advanceTimersByTimeAsync(110);
      await firstPromise;

      expect(firstRes.cacheMaxAge).toBe(2);
      expect(firstRes.streams).toContainEqual(expect.objectContaining({ _kafkaMatchMode: 'label' }));
      expect(firstRes.streams.some((s) => s.url.includes('nhl11-recovered'))).toBe(false);

      // Let slow candidates and NHL 11 retry finish in background.
      releaseSlow();
      await jest.advanceTimersByTimeAsync(2500);

      // Candidate-level attempts on NHL 11: 1st candidate attempt exhausted per-request retries,
      // then 2nd candidate attempt succeeded after queued first attempts started.
      const nhl11TraceProbes = traceLogs.filter((l) => l.includes('trex:836411') && l.includes('"probe_started"'));
      expect(nhl11TraceProbes).toHaveLength(2);
      expect(endedAttempts).toBe(1);
      expect(policyAttempts).toBe(1);
      expect(peakActive).toBe(4);
      const firstSlow3Idx = probeCallOrder.indexOf('trex:slow3');
      const lastNhl11Idx = probeCallOrder.lastIndexOf('trex:836411');
      expect(lastNhl11Idx).toBeGreaterThan(firstSlow3Idx);

      const repeatRes = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
      expect(repeatRes.streams.some((s) => s.url.includes('nhl11-recovered'))).toBe(true);
      expect(repeatRes.streams.some((s) => s._kafkaMatchMode === 'label')).toBe(true);
      const joinedTrace = traceLogs.join('\n');
      expect(joinedTrace).toContain('"queued"');
      expect(joinedTrace).toContain('"probe_started"');
      expect(joinedTrace).toContain('"retry_scheduled"');
      expect(joinedTrace).toContain('"verified"');
      expect(joinedTrace).toContain('"rejected"');
      expect(joinedTrace).toContain('"published"');
      expect(joinedTrace).not.toContain('SECRET_TOKEN_XYZ');
      expect(joinedTrace).not.toContain('secret.header');
      expect(joinedTrace).not.toContain('secret-token-should-not-leak');
      expect(joinedTrace).not.toContain('https://cdn.invalid');
    } finally {
      infoSpy.mockRestore();
    }
  });

  test('verifies recent media segment with playback headers and Range, handles slow advancing playlist, and rejects failing segment after retry', async () => {
    process.env.STREAM_SOFT_DEADLINE_MS = '400';
    process.env.STREAM_HARD_DEADLINE_MS = '800';
    const match = buildFixture({
      id: 'segment-liveness-ev',
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NBA TV HD', country: 'USA', matchMode: 'label' }]
    });
    const channels = [
      { id: 'trex:slow-adv', name: 'Live | Mavericks vs. Nuggets | US: PPV 1', score: 9000 },
      { id: 'trex:seg-retry', name: 'Live | Mavericks vs. Nuggets | US: PPV 2', score: 8500 },
      { id: 'trex:seg-dead', name: 'Live | Mavericks vs. Nuggets | US: PPV 3', score: 8000 },
      { id: 'trex:label', name: 'US| NBA TV HD' }
    ];

    const cancelSpies = [];
    const segCalls = [];
    let slowAttempt = 0;
    let segRetryCount = 0;

    setupHarness({
      match,
      channels,
      playlistHandler: async (target) => {
        if (target.includes('trex:slow-adv')) {
          slowAttempt += 1;
          if (slowAttempt <= 3) {
            throw Object.assign(new Error('slow playlist timeout'), { name: 'TimeoutError', code: 'ETIMEDOUT' });
          }
          return {
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:15\n#EXTINF:4,\nhttps://cdn.invalid/slow-15.ts\n#EXTINF:4,\nhttps://cdn.invalid/slow-16.ts\n'
          };
        }
        if (target.includes('trex:seg-retry')) {
          return {
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:20\n#EXTINF:4,\nhttps://cdn.invalid/retry-old.ts\n#EXTINF:4,\nhttps://cdn.invalid/retry-recent.ts\n'
          };
        }
        if (target.includes('trex:seg-dead')) {
          return {
            status: 200,
            text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:30\n#EXTINF:4,\nhttps://cdn.invalid/dead-recent.ts\n'
          };
        }
        return { status: 200, text: async () => LIVE_PLAYLIST };
      },
      segmentHandler: async (target, opts) => {
        segCalls.push({ target, headers: opts.headers });
        if (target.includes('dead-recent.ts')) {
          return { ok: false, status: 502, headers: { get: () => null }, body: { cancel: async () => {} } };
        }
        if (target.includes('retry-recent.ts')) {
          segRetryCount += 1;
          if (segRetryCount === 1) {
            return { ok: false, status: 502, headers: { get: () => null }, body: { cancel: async () => {} } };
          }
        }
        const cancelSpy = jest.fn(async () => {});
        cancelSpies.push(cancelSpy);
        return {
          ok: true,
          status: 206,
          headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'video/mp2t' : '1024') },
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(64) })),
                cancel: cancelSpy,
                releaseLock: () => {}
              };
            }
          }
        };
      }
    });

    const first = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 150);
    expect(first.streams.some((s) => s._kafkaMatchMode === 'label')).toBe(true);
    expect(first.streams.some((s) => s.url.includes('trex%3Aseg-retry'))).toBe(true);
    expect(first.streams.some((s) => s.url.includes('trex%3Aseg-dead'))).toBe(false);

    // Advance so slow-adv background retry finishes.
    await jest.advanceTimersByTimeAsync(15000);
    const repeat = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 150);
    expect(repeat.streams.some((s) => s.url.includes('trex%3Aslow-adv'))).toBe(true);
    expect(repeat.streams.some((s) => s.url.includes('trex%3Aseg-dead'))).toBe(false);

    // Recent segment selected, Range + headers forwarded, body cancelled after minimum evidence.
    expect(segCalls.some((c) => c.target.includes('slow-16.ts') && c.headers.Range === 'bytes=0-1023')).toBe(true);
    expect(segCalls.some((c) => c.target.includes('retry-recent.ts') && c.headers['User-Agent'])).toBe(true);
    expect(segCalls.some((c) => c.target.includes('retry-old.ts'))).toBe(false);
    expect(cancelSpies.length).toBeGreaterThan(0);
    expect(cancelSpies.every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  test('applies KAFKA_EVENT_MAX_CANDIDATES to unique candidates across retries', async () => {
    process.env.KAFKA_EVENT_MAX_CANDIDATES = '2';
    const match = buildFixture({ id: 'max-cand-unique', sources: [] });
    let c1Attempts = 0;
    const probedIds = [];

    setupHarness({
      match,
      channels: [
        { id: 'trex:c1', name: 'Live | Mavericks vs. Nuggets | US: PPV 1', score: 9000 },
        { id: 'trex:c2', name: 'Live | Mavericks vs. Nuggets | US: PPV 2', score: 8500 },
        { id: 'trex:c3', name: 'Live | Mavericks vs. Nuggets | US: PPV 3', score: 8000 }
      ],
      playlistHandler: async (target) => {
        if (target.includes('trex:c1')) {
          c1Attempts += 1;
          if (c1Attempts <= 3) return { status: 429, text: async () => 'Too Many Requests' };
        }
        return { status: 200, text: async () => LIVE_PLAYLIST };
      }
    });

    const baseSafe = safeFetch.getMockImplementation();
    safeFetch.mockImplementation(async (url, opts) => {
      if (String(url).includes('/stream/tv/')) {
        probedIds.push(decodeURIComponent(String(url).split('/stream/tv/')[1].replace(/\.json$/, '')));
      }
      return baseSafe(url, opts);
    });

    const res = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}));
    expect(res.streams).toHaveLength(2);
    expect(probedIds).not.toContain('trex:c3');
    expect(probedIds.filter((id) => id === 'trex:c1')).toHaveLength(2);
    expect(probedIds.filter((id) => id === 'trex:c2')).toHaveLength(1);
  });

  test('shares candidate entries across workers outside semaphore while keeping shared waits within deadlines, isolating progress rows, and fencing invalidated URLs', async () => {
    process.env.RESOLVE_CACHE_SHARED = 'true';
    process.env.KAFKA_EVENT_PROBE_CONCURRENCY = '4';
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';

    const match = buildFixture({
      id: 'shared-cand-fx',
      title: 'Utah Mammoth vs Minnesota Wild',
      category: 'hockey',
      league: 'NHL',
      team1: { name: 'Utah Mammoth' },
      team2: { name: 'Minnesota Wild' },
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NHL Network', country: 'USA', matchMode: 'label' }]
    });
    const channels = [
      { id: 'trex:836411', name: 'Live | Utah Mammoth vs Minnesota Wild | US: NHL 11', score: 9500 },
      { id: 'trex:label', name: 'US| NHL NETWORK HD' }
    ];

    const l2Table = new Map();
    const sharedResolver = {
      available: () => true,
      request: async (raw, options = {}) => {
        const url = new URL(raw);
        const key = decodeURIComponent(url.pathname.slice('/api/cache/'.length));
        if (url.searchParams.get('claim') === '1') {
          const cur = l2Table.get(key);
          if (cur && cur.expiresAt > Date.now() && (cur.status === 'ok' || cur.status === 'failed' || cur.status === 'minting')) {
            return { ok: true, json: async () => ({ ok: false, reason: 'already-claimed' }) };
          }
          const ownerToken = `tok-${Date.now()}-${Math.random()}`;
          l2Table.set(key, { status: 'minting', ownerToken, expiresAt: Date.now() + 30000 });
          return { ok: true, json: async () => ({ ok: true, ownerToken, supportsVacantClaim: true }) };
        }
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          const cur = l2Table.get(key);
          if (!cur || cur.ownerToken !== body.ownerToken) {
            return { ok: true, json: async () => ({ ok: false, reason: 'stale-owner' }) };
          }
          const revision = `rev-${Date.now()}-${Math.random().toString(16).slice(2, 10)}-0000-0000-000000000000`.slice(0, 36);
          const revUuid = '12345678-1234-4123-8123-1234567890ab';
          l2Table.set(key, {
            status: body.status,
            streams: body.streams,
            expiresAt: Date.now() + body.ttlMs,
            revision: cur.revision ? `aaaaaaaa-aaaa-4aaa-8aaa-${String(l2Table.size).padStart(12, '0')}` : revUuid
          });
          return { ok: true, json: async () => ({ ok: true, revision: l2Table.get(key).revision }) };
        }
        if (options.method === 'PATCH') {
          const cur = l2Table.get(key);
          if (cur && cur.revision === url.searchParams.get('revision')) l2Table.delete(key);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        if (options.method === 'DELETE') {
          const cur = l2Table.get(key);
          if (cur && cur.ownerToken === url.searchParams.get('ownerToken')) l2Table.delete(key);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        const cur = l2Table.get(key);
        if (!cur || cur.expiresAt <= Date.now()) {
          if (cur) l2Table.delete(key);
          return { ok: true, json: async () => ({ status: 'miss' }) };
        }
        return { ok: true, json: async () => cur };
      }
    };

    const dbPath = path.join(tmpDir, 'shared-catalog.sqlite');
    writeCatalogFile(dbPath, channels.map(c => ({ ...c, type: 'tv' })), { generatedAt: '2026-11-25T03:00:00Z', source: 'test' });
    const storeA = new TrexCatalogStore({ dbPath });
    const storeB = new TrexCatalogStore({ dbPath });
    stores.push(storeA, storeB);

    const makeProvider = (store) => new KafkaProvider({
      catalogStore: store,
      eventSearch: new TrexEventSearch({
        baseUrl: 'https://trex.invalid',
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ metas: [] }) }),
        now: () => Date.now()
      })
    });
    const providerA = makeProvider(storeA);
    const providerB = makeProvider(storeB);
    const cacheA = new StreamResolveCache({ sharedResolver });
    const cacheB = new StreamResolveCache({ sharedResolver });
    const m3u8Parser = new M3U8ParserService();
    const streamScorer = new StreamScoringService();

    let nhl11Count = 0;
    let releaseNhl11;
    let currentNhlToken = 'token-1';
    safeFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) {
        const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\.json$/, ''));
        if (id === 'trex:836411') {
          nhl11Count += 1;
          if (nhl11Count === 1) await new Promise((r) => { releaseNhl11 = r; });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              streams: [{
                name: '▶ Watch Live',
                title: id,
                url: `https://cdn.invalid/nhl11-${currentNhlToken}.m3u8`,
                behaviorHints: { proxyHeaders: { request: { Referer: 'https://ref.invalid/' } } }
              }]
            })
          };
        }
        return { ok: true, status: 200, json: async () => ({ streams: [{ name: '▶ Watch Live', title: id, url: `https://cdn.invalid/${id}.m3u8` }] }) };
      }
      return { status: 200, text: async () => LIVE_PLAYLIST };
    });
    streamingFetch.mockImplementation(async () => ({
      ok: true,
      status: 206,
      headers: { get: () => 'video/mp2t' },
      body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(64) })), cancel: async () => {}, releaseLock: () => {} }; } }
    }));

    const servicesA = { cacheService: { findMatch: () => match }, kafkaProvider: providerA, streamResolveCache: cacheA, m3u8Parser, streamScorer };
    const servicesB = { cacheService: { findMatch: () => match }, kafkaProvider: providerB, streamResolveCache: cacheB, m3u8Parser, streamScorer };

    container.resolve = (n) => servicesA[n];
    let firstA;
    const pA = handleStream('tv', `nuvio_sport_${match.id}`, {}).then((v) => { firstA = v; });
    await jest.advanceTimersByTimeAsync(110);
    await pA;
    expect(firstA.streams.map(s => s._kafkaMatchMode)).toEqual(['label']);
    expect(firstA.cacheMaxAge).toBe(2);

    releaseNhl11();
    await jest.advanceTimersByTimeAsync(200);

    // Hold all 4 semaphore slots on Worker B: L2 read for trex:836411 MUST still succeed outside semaphore!
    const releaseHolders = [];
    for (let i = 0; i < 4; i += 1) {
      providerB.withEventProbe(() => new Promise((r) => { releaseHolders.push(r); }));
    }
    container.resolve = (n) => servicesB[n];
    const coldB = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 100);
    expect(coldB.streams.some(s => s.url.includes('nhl11-token-1'))).toBe(true);
    expect(nhl11Count).toBe(1);
    for (const r of releaseHolders) r();
    await jest.advanceTimersByTimeAsync(50);

    // Token expires -> invalidate via candidate key -> A and B must re-mint token-2 instead of stale token-1.
    const candKey = `kafka:${match.id}:trex:836411:event-v4:${KICKOFF}`;
    expect(coldB.streams.find(s => s.url.includes('nhl11-token-1')).url).toContain(encodeURIComponent(candKey));
    currentNhlToken = 'token-2';
    cacheA.noteFailure(candKey);
    await jest.advanceTimersByTimeAsync(20);
    container.resolve = (n) => servicesA[n];
    const afterExpireA = await runWithTimers(() => handleStream('tv', `nuvio_sport_${match.id}`, {}), 100);
    expect(afterExpireA.streams.some(s => s.url.includes('nhl11-token-2'))).toBe(true);
    expect(afterExpireA.streams.some(s => s.url.includes('nhl11-token-1'))).toBe(false);
  });

  test('remints normalized SQLite event candidate via event-v4 key, rejects forged/mismatched kickoff keys, and preserves legacy channel remint', async () => {
    const { attemptRemint } = require('../src/remint');
    const NHL_KICKOFF = Date.UTC(2026, 10, 26, 0, 30);
    jest.setSystemTime(NHL_KICKOFF);
    const match = buildFixture({
      id: 'utah-wild-fx',
      title: 'Utah Mammoth vs Minnesota Wild',
      category: 'hockey',
      league: 'NHL',
      date: String(NHL_KICKOFF),
      team1: { name: 'Utah Mammoth' },
      team2: { name: 'Minnesota Wild' },
      sources: [{ source: 'kafka', id: 'trex:label', channelName: 'NHL Network', country: 'USA', matchMode: 'label' }]
    });
    const channels = [
      { id: 'flixlivetvtest:trex:1949763', name: 'US (ESPN+ 149) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:00)', grp: 'US (ESPN+ 149)' },
      { id: 'trex:label', name: 'US| NHL NETWORK HD' }
    ];
    const { services } = setupHarness({ match, channels });
    services.cacheService.getMatchesReadOnly = () => [match];

    let upstreamIds = [];
    safeFetch.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('/stream/tv/')) {
        const id = decodeURIComponent(target.split('/stream/tv/')[1].replace(/\.json$/, ''));
        upstreamIds.push(id);
        return {
          ok: true,
          status: 200,
          json: async () => ({ streams: [{ name: '▶ Watch Live', url: `https://cdn.invalid/reminted/${encodeURIComponent(id)}.m3u8?token=fresh` }] })
        };
      }
      return { status: 200, text: async () => LIVE_PLAYLIST };
    });

    const validKey = `kafka:${match.id}:flixlivetvtest:trex:1949763:event-v4:${NHL_KICKOFF}`;
    const forgedKey = `kafka:${match.id}:trex:forged-999:event-v4:${NHL_KICKOFF}`;
    const staleDateKey = `kafka:${match.id}:flixlivetvtest:trex:1949763:event-v4:${NHL_KICKOFF + 86400000}`;
    const legacyKey = `kafka:${match.id}:trex:label`;

    expect(await attemptRemint(forgedKey, 'https://cdn.invalid/old.m3u8')).toBeNull();
    expect(await attemptRemint(staleDateKey, 'https://cdn.invalid/old.m3u8')).toBeNull();
    expect(upstreamIds).toEqual([]);

    const freshEvent = await attemptRemint(validKey, 'https://cdn.invalid/reminted/old.m3u8?token=dead');
    expect(freshEvent).toContain('fresh');
    expect(upstreamIds).toEqual(['flixlivetvtest:trex:1949763']);

    const freshLegacy = await attemptRemint(legacyKey, 'https://cdn.invalid/reminted/old.m3u8?token=dead');
    expect(freshLegacy).toContain('fresh');
    expect(upstreamIds).toEqual(['flixlivetvtest:trex:1949763', 'trex:label']);
  });
});
