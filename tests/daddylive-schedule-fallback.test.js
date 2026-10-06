/**
 * Regression test: DaddyLive fixtures must not be dropped when the schedule
 * fetch fails.
 *
 * Production symptom this pins down (measured on the VPS):
 *   dlv: 651 | channels: 651 | fixtures: 0
 *
 * Mechanism: the 24/7-channel fix makes DaddyLive ALWAYS return channel rows,
 * even when the schedule fetch fails. MatchAggregator's carry-forward gate asked
 * "did this provider return anything?", which was true (channels), so it
 * concluded the provider was healthy and skipped the rescue - and every fixture
 * stayed lost.
 *
 * Fix: the provider declares its schedule health (`lastScheduleOk`), and the
 * aggregator treats a broken schedule as "not answered" regardless of how many
 * channel rows came back.
 *
 * These are pure unit tests with fake fetches - no network.
 */
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const MatchAggregator = require('../src/services/MatchAggregator');

// Minimal stand-in for CircuitBreakerService: runs the wrapped function directly.
// wrapSync mirrors wrap — the sync-path fetches (DaddyLive schedule/channels)
// declare themselves via wrapSync so the real breaker can use a cadence-aware
// rolling window; for the stub the behaviour is identical either way.
const fakeCB = {
  wrap: (name, fn) => ({ fire: () => fn() }),
  wrapSync: (name, fn) => ({ fire: () => fn() }),
};

const CHANNELS_HTML = '<a href="/watch.php?id=94"><div class="card__title">beIN Sports 4</div></a>';

// Only the dependencies the carry-forward path touches need to be present.
const baseParams = {
  timStreamsProvider: null, watchFootyProvider: null, cdnLiveProvider: null,
  streamSports99Provider: null, streamedPkProvider: null, yamlProviders: [],
  replayzoneProvider: null, liveTvProvider: null,
  damiTvProvider: null, ppvStProvider: null, teamLogoService: null,
};

function fakeCache(previous) {
  return {
    written: null,
    getMatches() { return previous.map((m) => JSON.parse(JSON.stringify(m))); },
    setMatches(v) { this.written = v; },
    isStale() { return false; },
  };
}

/** The exact production failure mode: schedule fails, channels succeed. */
function brokenScheduleProvider() {
  const p = new DaddyLiveProvider({ circuitBreaker: fakeCB });
  p.fetchSchedule = { fire: async () => null };
  p.fetchChannels = { fire: async () => CHANNELS_HTML };
  p.proxyFetch = async () => ({ ok: true, text: async () => '' });
  return p;
}

/** A provider whose schedule parsed correctly. */
function healthyProvider() {
  const p = new DaddyLiveProvider({ circuitBreaker: fakeCB });
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayHeader = `${dayNames[tomorrow.getUTCDay()]} ${tomorrow.getUTCDate()}th ${monthNames[tomorrow.getUTCMonth()]} ${tomorrow.getUTCFullYear()} - Schedule Time UK GMT`;

  p.fetchSchedule = { fire: async () => ({
    [dayHeader]: {
      Soccer: [{
        time: '22:00',
        event: 'Premier League : Team A vs Team B',
        channels: [{ channel_id: '11', channel_name: 'Sky Sports PL' }],
      }],
    },
  }) };
  p.fetchChannels = { fire: async () => '' };
  p.proxyFetch = async () => ({ ok: true, text: async () => '' });
  return p;
}

describe('DaddyLive schedule-health declaration', () => {
  test('starts unknown, exposes a stable sourceName', () => {
    const p = new DaddyLiveProvider({ circuitBreaker: fakeCB });
    expect(p.lastScheduleOk).toBeNull();
    expect(p.sourceName).toBe('daddylive');
  });

  test('records false when the schedule fails, but still returns channel rows', async () => {
    const p = brokenScheduleProvider();
    const out = await p.getMatches();
    expect(out.filter((m) => String(m.id).startsWith('dlv_ch_')).length).toBe(1);
    expect(p.lastScheduleOk).toBe(false);
  });

  test('records true when the schedule parses', async () => {
    const p = healthyProvider();
    const out = await p.getMatches();
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(p.lastScheduleOk).toBe(true);
  });
});

describe('carry-forward when a provider returns rows but its schedule failed', () => {
  test('rescues previously-known fixtures (the production regression)', async () => {
    const now = Date.now();
    const prevFixture = {
      id: 'dlv_999_old-fixture', title: 'Old A vs Old B', category: 'football',
      date: String(now - 3600e3),
      sources: [{ source: 'daddylive', id: '999', channelName: 'X' }],
    };
    const prevChannel = {
      id: 'dlv_ch_94_bein', title: 'beIN', category: 'networks', date: '0',
      sources: [{ source: 'daddylive', id: '94', channelName: 'beIN' }],
    };
    const other = { getMatches: async () => ([{
      id: 'cdn_ch_z', title: 'Sky', category: 'networks', date: '0',
      sources: [{ source: 'cdnlive', id: 'z' }],
    }]) };

    const cache = fakeCache([prevFixture, prevChannel]);
    const agg = new MatchAggregator({ ...baseParams, cacheService: cache });
    agg.providers = [other, brokenScheduleProvider()];

    await agg.syncMatches();

    const ids = (cache.written || []).map((m) => m.id);
    expect(ids).toContain('dlv_999_old-fixture');          // fixtures rescued
    expect(ids.some((i) => i.startsWith('dlv_ch_'))).toBe(true); // channels kept
    expect(new Set(ids).size).toBe(ids.length);            // no duplicates
  });

  test('does NOT resurrect stale rows when the schedule is healthy', async () => {
    const staleFixture = {
      id: 'dlv_111_gone', title: 'Gone A vs Gone B', category: 'football',
      date: String(Date.now() - 3600e3),
      sources: [{ source: 'daddylive', id: '111' }],
    };

    const cache = fakeCache([staleFixture]);
    const agg = new MatchAggregator({ ...baseParams, cacheService: cache });
    agg.providers = [healthyProvider()];

    await agg.syncMatches();

    const ids = (cache.written || []).map((m) => m.id);
    expect(ids).not.toContain('dlv_111_gone');
  });
});
