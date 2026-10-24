'use strict';

/**
 * Regression tests for the syncMatches single-flight guard and the
 * catalog-triggered sync cooldown.
 *
 * Background: catalog paths called aggregator.syncMatches() directly whenever
 * a replay sport had zero content. syncMatches had no in-flight dedup, so
 * concurrent requests each ran a FULL provider sweep in the same worker —
 * every one holding a previous-catalog clone and writing the disk cache —
 * stacking to the PM2 memory ceiling under traffic. And because "sport X has
 * no replays" is a stable condition, a sport with no replay coverage
 * re-triggered a full sweep on EVERY request, forever.
 */

const MatchAggregator = require('../src/services/MatchAggregator');

function buildSlowAggregator() {
  let sweeps = 0;
  const agg = new MatchAggregator({
    cacheService: { getMatches: () => [], setMatches: () => {} },
  });
  agg.providers = [
    {
      sourceName: 'replayzone',
      getMatches: async () => {
        sweeps++;
        // Hold the sweep open so concurrent callers arrive mid-flight.
        await new Promise((r) => setTimeout(r, 25));
        return [{
          id: 'rz_1',
          title: 'Arsenal vs Chelsea Full Match Replay',
          category: 'football',
          date: '2026-10-01',
          status: 'finished',
          sources: [{ source: 'replayzone', id: 's1' }],
        }];
      },
    },
  ];
  return { agg, sweeps: () => sweeps };
}

describe('MatchAggregator syncMatches single-flight', () => {
  test('concurrent callers share one in-flight sweep and its result', async () => {
    const { agg, sweeps } = buildSlowAggregator();
    const [a, b, c] = await Promise.all([
      agg.syncMatches(),
      agg.syncMatches(),
      agg.syncMatches(),
    ]);
    expect(sweeps()).toBe(1);
    // All callers resolve to the same sweep result (same array reference).
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(a.length).toBe(1);
  });

  test('guard clears after completion so a later call runs a fresh sweep', async () => {
    const { agg, sweeps } = buildSlowAggregator();
    await agg.syncMatches();
    await agg.syncMatches();
    expect(sweeps()).toBe(2);
  });

  test('a failed sweep clears the guard so the next call can retry', async () => {
    let calls = 0;
    const agg = new MatchAggregator({
      cacheService: {
        getMatches: () => [],
        setMatches: () => {
          calls++;
          if (calls === 1) throw new Error('disk full');
        },
      },
    });
    agg.providers = [{
      sourceName: 'replayzone',
      getMatches: async () => [{
        id: 'rz_1',
        title: 'Arsenal vs Chelsea Full Match Replay',
        category: 'football',
        date: '2026-10-01',
        status: 'finished',
        sources: [{ source: 'replayzone', id: 's1' }],
      }],
    }];

    await expect(agg.syncMatches()).rejects.toThrow('disk full');
    // The in-flight promise must be released even after a rejection.
    const retried = await agg.syncMatches();
    expect(retried.length).toBe(1);
  });
});

describe('MatchAggregator syncMatchesIfStale cooldown', () => {
  test('refuses to start a new sweep within the cooldown window', async () => {
    const { agg, sweeps } = buildSlowAggregator();
    const first = await agg.syncMatches();
    expect(first.length).toBe(1);

    const second = await agg.syncMatchesIfStale();
    expect(second).toBeNull();
    expect(sweeps()).toBe(1);
  });

  test('sweeps again once the interval elapses', async () => {
    const { agg, sweeps } = buildSlowAggregator();
    await agg.syncMatches();

    const again = await agg.syncMatchesIfStale(0);
    expect(again && again.length).toBe(1);
    expect(sweeps()).toBe(2);
  });

  test('joins an in-flight sweep instead of starting a parallel one', async () => {
    const { agg, sweeps } = buildSlowAggregator();
    const p1 = agg.syncMatches();        // starts the sweep (25ms)
    const p2 = agg.syncMatchesIfStale(); // arrives mid-flight — must join it
    const [a, b] = await Promise.all([p1, p2]);
    expect(sweeps()).toBe(1);
    expect(b).toBe(a);
  });

  test('first-ever call is not blocked (cold catalog can sync immediately)', async () => {
    const { agg, sweeps } = buildSlowAggregator();
    const result = await agg.syncMatchesIfStale();
    expect(result && result.length).toBe(1);
    expect(sweeps()).toBe(1);
  });
});
