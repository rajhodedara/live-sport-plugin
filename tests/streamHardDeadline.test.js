jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/TimingRuntime', () => ({ relations: { stream: jest.fn(() => ({})), endWindow: jest.fn() } }));
const container = require('../src/container');
const { relations } = require('../src/services/TimingRuntime');
const { handleStream } = require('../src/streams');

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const playable = url => ({ url, _source: 'pitsport', title: 'Main feed' });

describe('handleStream hard response deadline', () => {
  const env = {
    soft: process.env.STREAM_SOFT_DEADLINE_MS,
    hard: process.env.STREAM_HARD_DEADLINE_MS,
    donation: process.env.DONATION_URL
  };
  let pending;
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.STREAM_SOFT_DEADLINE_MS = '100';
    process.env.STREAM_HARD_DEADLINE_MS = '200';
    process.env.DONATION_URL = 'disabled';
    pending = [deferred(), deferred()];
    const match = { id: 'deadline', title: 'Team A vs Team B', category: 'football',
      sources: [{ source: 'pitsport', id: 'a' }, { source: 'timstreams', id: 'b' }] };
    const services = {
      cacheService: { findMatch: () => match },
      streamResolveCache: { getOrCreate: jest.fn(key => pending[key.endsWith(':a') ? 0 : 1].promise) },
      streamScorer: { calculateScore: () => 1 },
    };
    container.resolve.mockImplementation(name => services[name]);
  });
  afterEach(() => {
    jest.useRealTimers();
    for (const [key, value] of [
      ['STREAM_SOFT_DEADLINE_MS', env.soft],
      ['STREAM_HARD_DEADLINE_MS', env.hard],
      ['DONATION_URL', env.donation]
    ]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    jest.clearAllMocks();
  });

  test('returns at the hard deadline even if every provider stays pending', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    expect(response.streams).toEqual([]);
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 2, 'hard_wait_expired');
  });

  test('keeps a stream arriving between soft and hard deadlines without awaiting a stalled peer', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(150);
    pending[0].resolve([playable('https://cdn.example/live.mp4')]);
    await jest.advanceTimersByTimeAsync(50);
    expect(response).toBeDefined();
    expect(response.streams.map(s => s.url)).toEqual(['https://cdn.example/live.mp4']);
  });

  test('late fulfillment does not mutate an already returned response', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    pending[0].resolve([playable('https://cdn.example/late.mp4')]);
    pending[1].reject(new Error('late failure'));
    await jest.advanceTimersByTimeAsync(0);
    expect(response.streams).toEqual([]);
  });

  test('clears response-wait timers when all providers resolve immediately', async () => {
    pending[0].resolve([playable('https://cdn.example/fast.mp4')]);
    pending[1].resolve([]);
    const response = await handleStream('tv', 'nuvio_sport_deadline');
    expect(response.streams).toHaveLength(1);
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 0, 'all_settled');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a soft deadline larger than the hard deadline cannot extend the response wait', async () => {
    process.env.STREAM_SOFT_DEADLINE_MS = '500';
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    await jest.advanceTimersByTimeAsync(200);
    expect(response).toBeDefined();
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 2, 'budget_exhausted');
  });

  test('for TV channel networks, does not early-return at soft deadline when secondary streams are in flight until quorum is reached', async () => {
    const channelMatch = {
      id: 'dlv_ch_339_cartoon-network',
      title: 'Cartoon Network',
      category: 'networks',
      sources: [
        { source: 'daddylive', id: '339' },
        { source: 'vavoo', id: 'v1' },
      ],
    };
    const services = {
      cacheService: { findMatch: () => channelMatch },
      streamResolveCache: { getOrCreate: jest.fn(key => pending[key.startsWith('daddylive:') ? 0 : 1].promise) },
      streamScorer: { calculateScore: () => 1 },
    };
    container.resolve.mockImplementation(name => services[name]);

    let response;
    handleStream('tv', 'nuvio_sport_dlv_ch_339_cartoon-network').then(value => { response = value; });

    // Priority-1 (DaddyLive) completes early at 50ms with 1 stream
    await jest.advanceTimersByTimeAsync(50);
    pending[0].resolve([playable('https://cdn.example/daddylive.m3u8')]);

    // Soft deadline passes at 100ms: response should NOT be returned yet because Vavoo is still in flight
    await jest.advanceTimersByTimeAsync(60);
    expect(response).toBeUndefined();

    // Secondary stream (Vavoo) resolves at 150ms
    pending[1].resolve([playable('https://cdn.example/vavoo.m3u8')]);
    await jest.advanceTimersByTimeAsync(10);

    expect(response).toBeDefined();
    expect(response.streams).toHaveLength(2);
  });

  test('for TV channel networks, does not early-return at soft deadline when priority source returns multiple streams below quorum', async () => {
    const channelMatch = {
      id: 'dlv_ch_339_cartoon-network',
      title: 'Cartoon Network',
      category: 'networks',
      sources: [
        { source: 'daddylive', id: '339' },
        { source: 'vavoo', id: 'v1' },
      ],
    };
    const services = {
      cacheService: { findMatch: () => channelMatch },
      streamResolveCache: { getOrCreate: jest.fn(key => pending[key.startsWith('daddylive:') ? 0 : 1].promise) },
      streamScorer: { calculateScore: () => 1 },
    };
    container.resolve.mockImplementation(name => services[name]);

    let response;
    handleStream('tv', 'nuvio_sport_dlv_ch_339_cartoon-network').then(value => { response = value; });

    // Priority-1 (DaddyLive) completes early at 50ms with 2 streams (still < quorum of 5)
    await jest.advanceTimersByTimeAsync(50);
    pending[0].resolve([
      playable('https://cdn.example/daddylive-hd.m3u8'),
      playable('https://cdn.example/daddylive-sd.m3u8'),
    ]);

    // Soft deadline passes at 100ms: response should NOT be returned yet because Vavoo is still in flight
    await jest.advanceTimersByTimeAsync(60);
    expect(response).toBeUndefined();

    // Secondary stream (Vavoo) resolves at 150ms with 2 streams
    pending[1].resolve([
      playable('https://cdn.example/vavoo-1.m3u8'),
      playable('https://cdn.example/vavoo-2.m3u8'),
    ]);
    await jest.advanceTimersByTimeAsync(10);

    expect(response).toBeDefined();
    expect(response.streams).toHaveLength(4);
  });

  test('labels an early return while another source continues in the background', async () => {
    let response;
    handleStream('tv', 'nuvio_sport_deadline').then(value => { response = value; });
    pending[0].resolve([playable('https://cdn.example/fast.mp4')]);
    await jest.advanceTimersByTimeAsync(100);
    expect(response.streams).toHaveLength(1);
    expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 1, 'early_return');
  });

  test('late provider completion still warms the real cache for the next request', async () => {
    const shared = process.env.RESOLVE_CACHE_SHARED;
    process.env.RESOLVE_CACHE_SHARED = 'false';
    try {
      const Cache = require('../src/services/StreamResolveCache');
      const cache = new Cache();
      const findMatch = () => ({ id: 'deadline', title: 'Team A vs Team B', category: 'football',
        sources: [{ source: 'timstreams', id: 'a' }] });
      const provider = { resolveStream: jest.fn(() => pending[0].promise) };
      const services = {
        cacheService: { findMatch }, streamResolveCache: cache,
        streamScorer: { calculateScore: () => 1 }, m3u8Parser: {}, timStreamsProvider: provider,
      };
      container.resolve.mockImplementation(name => services[name]);
      let first;
      handleStream('tv', 'nuvio_sport_deadline').then(value => { first = value; });
      await jest.advanceTimersByTimeAsync(200);
      expect(first.streams).toEqual([]);
      pending[0].resolve([{ url: 'https://cdn.example/late.mp4', title: 'Main feed' }]);
      await jest.advanceTimersByTimeAsync(0);
      expect(cache.get('timstreams:deadline:a')).toHaveLength(1);
      const second = await handleStream('tv', 'nuvio_sport_deadline');
      expect(second.streams.map(s => s.url)).toEqual(['https://cdn.example/late.mp4']);
      expect(first.streams).toEqual([]);
      expect(provider.resolveStream).toHaveBeenCalledTimes(1);
    } finally {
      if (shared === undefined) delete process.env.RESOLVE_CACHE_SHARED;
      else process.env.RESOLVE_CACHE_SHARED = shared;
    }
  });

  test('waits past soft deadline to hard deadline while event discovery is pending with no ready Kafka row yet', async () => {
    const prevEventFirst = process.env.KAFKA_EVENT_FIRST_ENABLED;
    const prevEnabled = process.env.KAFKA_ENABLED;
    const prevManifest = process.env.KAFKA_MANIFEST_URL;
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    process.env.KAFKA_ENABLED = 'true';
    process.env.KAFKA_MANIFEST_URL = 'https://trex.invalid/manifest.json';

    try {
      const eventMatch = {
        id: 'ev-soft',
        title: 'Team A vs Team B',
        category: 'football',
        date: Date.now(),
        team1: 'Team A',
        team2: 'Team B',
        sources: [{ source: 'daddylive', id: 'dl1', channelName: 'TNT Sports 1' }]
      };
      const eventDeferred = deferred();
      const daddyliveDeferred = deferred();
      const kp = {
        configured: true,
        isEventFixtureEligible: () => true
      };
      const services = {
        cacheService: { findMatch: () => eventMatch },
        streamResolveCache: {
          getOrCreate: jest.fn(key => (key.includes('fixture-events-') ? eventDeferred.promise : daddyliveDeferred.promise))
        },
        streamScorer: { calculateScore: () => 1 },
        kafkaProvider: kp
      };
      container.resolve.mockImplementation(name => services[name]);

      let response;
      handleStream('tv', 'nuvio_sport_ev-soft').then(value => { response = value; });
      daddyliveDeferred.resolve([{ url: 'https://cdn.example/dl.m3u8', _source: 'daddylive', channelName: 'TNT Sports 1' }]);
      await jest.advanceTimersByTimeAsync(110);
      expect(response).toBeUndefined();

      await jest.advanceTimersByTimeAsync(90);
      expect(response).toBeDefined();
      expect(response.streams.map(s => s.url)).toEqual(['https://cdn.example/dl.m3u8']);
      expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 1, 'hard_wait_expired');
    } finally {
      if (prevEventFirst === undefined) delete process.env.KAFKA_EVENT_FIRST_ENABLED; else process.env.KAFKA_EVENT_FIRST_ENABLED = prevEventFirst;
      if (prevEnabled === undefined) delete process.env.KAFKA_ENABLED; else process.env.KAFKA_ENABLED = prevEnabled;
      if (prevManifest === undefined) delete process.env.KAFKA_MANIFEST_URL; else process.env.KAFKA_MANIFEST_URL = prevManifest;
    }
  });

  test('returns ready Kafka channel at soft deadline while event discovery is pending', async () => {
    const prevEventFirst = process.env.KAFKA_EVENT_FIRST_ENABLED;
    const prevEnabled = process.env.KAFKA_ENABLED;
    const prevManifest = process.env.KAFKA_MANIFEST_URL;
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    process.env.KAFKA_ENABLED = 'true';
    process.env.KAFKA_MANIFEST_URL = 'https://trex.invalid/manifest.json';

    try {
      const eventMatch = {
        id: 'ev-soft-chan',
        title: 'Team A vs Team B',
        category: 'football',
        date: Date.now(),
        team1: 'Team A',
        team2: 'Team B',
        sources: [{ source: 'kafka', id: 'trex:label', channelName: 'TNT Sports 1', matchMode: 'label' }]
      };
      const eventDeferred = deferred();
      const channelDeferred = deferred();
      const kp = {
        configured: true,
        isEventFixtureEligible: () => true
      };
      const services = {
        cacheService: { findMatch: () => eventMatch },
        streamResolveCache: {
          getOrCreate: jest.fn(key => (key.includes('fixture-events-') ? eventDeferred.promise : channelDeferred.promise))
        },
        streamScorer: { calculateScore: () => 1 },
        kafkaProvider: kp
      };
      container.resolve.mockImplementation(name => services[name]);

      let response;
      handleStream('tv', 'nuvio_sport_ev-soft-chan').then(value => { response = value; });
      channelDeferred.resolve([{ url: 'https://cdn.example/kafka-chan.m3u8', _source: 'kafka', _kafkaMatchMode: 'label', channelName: 'TNT Sports 1' }]);
      await jest.advanceTimersByTimeAsync(99);
      expect(response).toBeUndefined();
      await jest.advanceTimersByTimeAsync(11);
      expect(response).toBeDefined();
      expect(response.cacheMaxAge).toBe(2);
      expect(response.streams).toContainEqual(expect.objectContaining({ _kafkaMatchMode: 'label' }));
      expect(relations.endWindow).toHaveBeenCalledWith(expect.anything(), 2, 1, 'early_return');
    } finally {
      if (prevEventFirst === undefined) delete process.env.KAFKA_EVENT_FIRST_ENABLED; else process.env.KAFKA_EVENT_FIRST_ENABLED = prevEventFirst;
      if (prevEnabled === undefined) delete process.env.KAFKA_ENABLED; else process.env.KAFKA_ENABLED = prevEnabled;
      if (prevManifest === undefined) delete process.env.KAFKA_MANIFEST_URL; else process.env.KAFKA_MANIFEST_URL = prevManifest;
    }
  });

  test('collectEventStreams stops queued work at fake job deadline and detaches timed-out HTTP viewer without aborting job', async () => {
    const { collectEventStreams } = require('../src/services/KafkaEventPlayback');
    const prevJobTimeout = process.env.KAFKA_EVENT_JOB_TIMEOUT_MS;
    process.env.KAFKA_EVENT_JOB_TIMEOUT_MS = '300';
    try {
      const candidates = [
        { id: 'c1', name: 'Live | A vs B | 1' },
        { id: 'c2', name: 'Live | A vs B | 2' },
        { id: 'c3', name: 'Live | A vs B | 3' }
      ];
      const provider = {
        getEventProbeConcurrency: () => 1,
        withEventProbe: (fn, sig) => fn(sig),
        eventCandidates: jest.fn(async () => candidates)
      };
      const jobSignals = [];
      const probed = [];
      let releaseFirst;
      const probe = jest.fn(async (candidate, sig) => {
        probed.push(candidate.id);
        jobSignals.push(sig);
        if (candidate.id === 'c1') {
          await new Promise((resolve) => {
            releaseFirst = resolve;
            sig?.addEventListener('abort', resolve, { once: true });
          });
          return { streams: [], retryableReason: 'playlist_timeout' };
        }
        return { streams: [{ url: `https://cdn.example/${candidate.id}.m3u8` }], retryableReason: null };
      });
      const events = [];
      const httpCtrl = new AbortController();
      const firstViewer = collectEventStreams({
        provider,
        match: { id: 'job-deadline-fx', date: '1700000000000' },
        signal: httpCtrl.signal,
        probe,
        onCandidateOutcome: (e) => events.push(e)
      });

      await jest.advanceTimersByTimeAsync(100);
      httpCtrl.abort(new Error('HTTP viewer timed out'));
      const firstResult = await firstViewer;
      expect(firstResult.incomplete).toBe(true);
      expect(firstResult.streams).toEqual([]);
      // Viewer HTTP abort must NOT abort the background job signal.
      expect(jobSignals[0]?.aborted).toBe(false);

      // At 300ms job deadline, job aborts c1 and stops queued c2/c3 without running them.
      await jest.advanceTimersByTimeAsync(250);
      expect(jobSignals[0]?.aborted).toBe(true);
      expect(probed).toEqual(['c1']);
      expect(events).toContainEqual(expect.objectContaining({ candidateId: 'c2', stage: 'rejected', reason: 'deadline_expired' }));
      expect(firstResult.streams).toEqual([]);
      if (releaseFirst) releaseFirst();
    } finally {
      if (prevJobTimeout === undefined) delete process.env.KAFKA_EVENT_JOB_TIMEOUT_MS;
      else process.env.KAFKA_EVENT_JOB_TIMEOUT_MS = prevJobTimeout;
    }
  });
});
