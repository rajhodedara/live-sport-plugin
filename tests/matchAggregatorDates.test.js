'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');

// The constructor only stores providers; the date/identity logic under test is
// pure, so stub dependencies are sufficient.
const agg = new MatchAggregator({});

function replayZoneMatch(title, dateStr) {
  return {
    id: 'rz_' + title.replace(/\W+/g, '-').toLowerCase(),
    title,
    date: dateStr,
    status: 'finished',
    category: 'baseball',
    sources: [{ source: 'replayzone', id: 'u', url: 'u' }]
  };
}

function streamSports99Match(title, epoch) {
  return {
    id: 'ss99_1',
    title,
    date: epoch,
    status: 'upcoming',
    category: 'baseball',
    sources: [{ source: 'streamsports99', id: 'x', url: 'x' }]
  };
}

describe('MatchAggregator date parsing', () => {
  test('parses ISO date strings from ReplayZone into epoch ms', () => {
    expect(agg._precompute(replayZoneMatch('A @ B', '2026-09-14')).date).toBe(Date.parse('2026-09-14'));
  });

  test('keeps parsing numeric epochs from other providers', () => {
    expect(agg._precompute(streamSports99Match('A vs B', 1789495800000)).date).toBe(1789495800000);
  });

  test('keeps parsing numeric epoch strings', () => {
    expect(agg._precompute(streamSports99Match('A vs B', '1789495800000')).date).toBe(1789495800000);
  });

  test('treats absent or unparseable dates as 0', () => {
    expect(agg._precompute({ title: 'A vs B', date: null }).date).toBe(0);
    expect(agg._precompute({ title: 'A vs B', date: '' }).date).toBe(0);
    expect(agg._precompute({ title: 'A vs B', date: 'not-a-date' }).date).toBe(0);
    expect(agg._precompute({ title: 'A vs B' }).date).toBe(0);
  });
});

describe('match merge isolation (regression)', () => {
  test('a replay from a different date does not merge into a live fixture', () => {
    // Production case: an upcoming "Chicago Cubs vs Atlanta Braves" fixture had
    // replay streams from unrelated May meetings attached to it, because ISO
    // dates were collapsing to 0 and disabling the date-window guard.
    const fixture = streamSports99Match('Chicago Cubs vs Atlanta Braves', 1789495800000);
    const mayReplay = replayZoneMatch(
      'Chicago Cubs @ Atlanta Braves Full Game Replay May 14, 2026 MLB',
      '2026-05-14'
    );

    const pFixture = agg._precompute(fixture);
    const pReplay = agg._precompute(mayReplay);

    expect(pReplay.date).not.toBe(0);
    expect(agg._sameEventPre(pReplay, pFixture)).toBe(false);
    expect(agg._sameEventPre(pFixture, pReplay)).toBe(false);
  });

  test('replays a day apart stay separate', () => {
    const fixture = streamSports99Match('Chicago Cubs vs Atlanta Braves', 1789495800000);
    const sep14 = replayZoneMatch('Atlanta Braves @ Chicago Cubs - MLB Full Game Replay - September 14, 2026', '2026-09-14');

    const pFixture = agg._precompute(fixture);
    const pReplay = agg._precompute(sep14);

    expect(agg._sameEventPre(pReplay, pFixture)).toBe(false);
  });

  test('the same event from two providers still merges', () => {
    const a = streamSports99Match('Chicago Cubs vs Atlanta Braves', 1789495800000);
    const b = replayZoneMatch('Chicago Cubs vs Atlanta Braves', String(1789495800000));

    const pa = agg._precompute(a);
    const pb = agg._precompute(b);

    expect(agg._sameEventPre(pa, pb)).toBe(true);
  });
});

describe('Kickoff timestamp parsing and timezone formatting', () => {
  const { getKickoff, mapMatchToMetaPreview } = require('../src/catalog');

  test('getKickoff parses UTC date strings correctly into epoch milliseconds', () => {
    // 2026-09-20 17:00 UTC = 1789923600000 ms
    expect(getKickoff('2026-09-20 17:00')).toBe(1789923600000);
    expect(getKickoff('2026-09-20T17:00:00Z')).toBe(1789923600000);
    expect(getKickoff(1789923600000)).toBe(1789923600000);
    expect(getKickoff('1789923600000')).toBe(1789923600000);
  });

  test('mapMatchToMetaPreview formats kickoff at 10:00 AM for America/Los_Angeles (Chicago Bears vs Minnesota Vikings)', () => {
    const match = {
      id: 'bears_vikings',
      title: 'Chicago Bears vs Minnesota Vikings',
      category: 'american_football',
      date: '1789923600000', // 2026-09-20 17:00:00 UTC
      status: 'upcoming',
      sources: [{ source: 'streamedpk', id: '123' }]
    };

    const meta = mapMatchToMetaPreview(match, { timezone: 'America/Los_Angeles' }, 'tv');
    expect(meta.releaseInfo).toBe('10:00 AM (America/Los_Angeles)');
    expect(meta.description).toContain('⏱️ Kickoff at 10:00 AM (America/Los_Angeles)');
  });
});

