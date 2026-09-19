'use strict';

const { isReplayMatch, isMatchLive, mapMatchToMetaPreview } = require('../src/catalog');

const HOUR = 3600 * 1000;
const now = Date.now();

/** A finished match from a replay-style source. */
function finishedMatch(overrides = {}) {
  return {
    id: 'rz_test-fixture-1',
    title: 'Miami Marlins @ Arizona Diamondbacks - MLB Full Game Replay - September 14, 2026',
    category: 'baseball',
    league: 'MLB',
    date: String(now - 5 * HOUR),
    status: 'finished',
    sources: [{ source: 'replayzone', id: 'https://ok.ru/videoembed/1', url: 'https://ok.ru/videoembed/1' }],
    ...overrides
  };
}

/** A fixture that has not started yet. */
function upcomingMatch(overrides = {}) {
  return {
    id: 'test-upcoming-1',
    title: 'Arsenal vs Chelsea',
    category: 'football',
    league: 'Premier League',
    date: String(now + 6 * HOUR),
    status: 'upcoming',
    sources: [{ source: 'watchfooty', id: 'x', url: 'https://example.com/x' }],
    ...overrides
  };
}

describe('isReplayMatch', () => {
  test('classifies a finished event as a replay', () => {
    expect(isReplayMatch(finishedMatch())).toBe(true);
  });

  test('does not classify an upcoming fixture as a replay', () => {
    expect(isReplayMatch(upcomingMatch())).toBe(false);
  });

  test('does not classify a currently live event as a replay', () => {
    const live = { id: 'l', title: 'A vs B', category: 'football', date: String(now - 10 * 60 * 1000), status: 'live', sources: [] };
    expect(isMatchLive(live)).toBe(true);
    expect(isReplayMatch(live)).toBe(false);
  });

  test('never treats 24/7 networks as replays', () => {
    const network = { id: 'n', title: 'Sky Sports F1', category: 'networks', sources: [], status: 'finished', date: String(now - HOUR) };
    expect(isReplayMatch(network)).toBe(false);
  });

  test('excludes postponed and cancelled events', () => {
    expect(isReplayMatch(finishedMatch({ status: 'postponed' }))).toBe(false);
    expect(isReplayMatch(finishedMatch({ status: 'cancelled' }))).toBe(false);
  });

  test('handles missing input safely', () => {
    expect(isReplayMatch(null)).toBe(false);
    expect(isReplayMatch(undefined)).toBe(false);
    expect(isReplayMatch({})).toBe(false);
  });
});

describe('stale provider status (regression)', () => {
  // Providers cache the match status at fetch time. A fixture still flagged
  // "upcoming" after kickoff used to be classified as a replay (because it was
  // "not currently live"), so an in-progress game appeared under Sports Replays
  // carrying only live sources and no replay feed.
  const DURATIONS = { baseball: 3.5 * HOUR, football: 2.5 * HOUR, basketball: 3 * HOUR };

  test('an in-progress match flagged "upcoming" is live, not a replay', () => {
    const startedMinutesAgo = 56;
    const m = {
      id: 'ss99_2557385',
      title: 'Colorado Rockies vs San Diego Padres',
      category: 'baseball',
      status: 'upcoming',
      date: String(now - startedMinutesAgo * 60 * 1000),
      sources: [{ source: 'streamedpk', id: 'x', url: 'x' }]
    };

    expect(isMatchLive(m)).toBe(true);
    expect(isReplayMatch(m)).toBe(false);
  });

  test('a genuinely upcoming match is neither live nor a replay', () => {
    expect(isMatchLive(upcomingMatch())).toBe(false);
    expect(isReplayMatch(upcomingMatch())).toBe(false);
  });

  test('a match becomes a replay only after its live window has elapsed', () => {
    // 1 hour after kickoff: still within the baseball window -> live
    const inWindow = {
      id: 'b1', title: 'A vs B', category: 'baseball', status: 'upcoming',
      date: String(now - 1 * HOUR), sources: []
    };
    expect(isMatchLive(inWindow)).toBe(true);
    expect(isReplayMatch(inWindow)).toBe(false);

    // 6 hours after kickoff: window elapsed -> replay
    const elapsed = {
      id: 'b2', title: 'A vs B', category: 'baseball', status: 'upcoming',
      date: String(now - 6 * HOUR), sources: []
    };
    expect(isMatchLive(elapsed)).toBe(false);
    expect(isReplayMatch(elapsed)).toBe(true);
  });

  test('the live window is sport-aware', () => {
    // 3 hours after kickoff is still within baseball's 3.5h window...
    const baseball = {
      id: 'b3', title: 'A vs B', category: 'baseball', status: 'upcoming',
      date: String(now - 3 * HOUR), sources: []
    };
    // ...but well past football's 2.5h window.
    const football = {
      id: 'f3', title: 'A vs B', category: 'football', status: 'upcoming',
      date: String(now - 3 * HOUR), sources: []
    };

    expect(isMatchLive(baseball)).toBe(true);
    expect(isReplayMatch(baseball)).toBe(false);

    expect(isMatchLive(football)).toBe(false);
    expect(isReplayMatch(football)).toBe(true);
  });

  test('explicit terminal status still wins immediately', () => {
    const finished = {
      id: 'f4', title: 'A vs B', category: 'baseball', status: 'finished',
      date: String(now - 30 * 60 * 1000), sources: []
    };
    expect(isReplayMatch(finished)).toBe(true);
  });

  test('a dated match with no usable kickoff is not treated as a replay', () => {
    const m = {
      id: 'x1', title: 'A vs B', category: 'football', status: 'live',
      date: '', sources: []
    };
    expect(isReplayMatch(m)).toBe(false);
  });

  test('DURATIONS table stays in sync with the classifier', () => {
    // Guards against the two drifting apart again.
    for (const [category, duration] of Object.entries(DURATIONS)) {
      const justInside = {
        id: category, title: 'A vs B', category, status: 'upcoming',
        date: String(now - (duration - 60000)), sources: []
      };
      expect(isReplayMatch(justInside)).toBe(false);
    }
  });
});

describe('mapMatchToMetaPreview replay labelling', () => {
  test('a replay is labelled ⏪ with a past-tense status, not a kickoff countdown', () => {
    const meta = mapMatchToMetaPreview(finishedMatch());

    expect(meta.name.startsWith('⏪')).toBe(true);
    expect(meta.releaseInfo).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    expect(meta.description).toContain('Replay');
    expect(meta.description).not.toContain('Kickoff at');
  });

  test('an upcoming fixture keeps the ⏱️ prefix and kickoff status', () => {
    const meta = mapMatchToMetaPreview(upcomingMatch());

    expect(meta.name.startsWith('⏱️')).toBe(true);
    expect(meta.description).toContain('Kickoff at');
    expect(meta.description).not.toContain('Replay from');
  });

  test('a live match keeps the 🔴 LIVE prefix', () => {
    const live = { id: 'l', title: 'A vs B', category: 'football', date: String(now - 10 * 60 * 1000), status: 'live', sources: [] };
    const meta = mapMatchToMetaPreview(live);

    expect(meta.name.startsWith('🔴 LIVE:')).toBe(true);
    expect(meta.description).toContain('LIVE NOW');
  });

  test('replay and upcoming of the same event render distinguishably', () => {
    const replayMeta = mapMatchToMetaPreview(finishedMatch());
    const upcomingMeta = mapMatchToMetaPreview(upcomingMatch());

    expect(replayMeta.name).not.toBe(upcomingMeta.name);
    expect(replayMeta.releaseInfo).not.toBe(upcomingMeta.releaseInfo);
    expect(replayMeta.description).not.toBe(upcomingMeta.description);
  });

  test('the nuvio_sport_ id prefix is preserved for replays', () => {
    const meta = mapMatchToMetaPreview(finishedMatch());
    expect(meta.id).toBe('nuvio_sport_rz_test-fixture-1');
    expect(meta.type).toBe('series');
    expect(meta.behaviorHints.defaultVideoId).toBe('nuvio_sport_rz_test-fixture-1:1:1');
  });
});

describe('ReplayZone provider restriction & Live timing precision', () => {
  const { getKickoff } = require('../src/catalog');

  test('only replayzone source is classified as a replay', () => {
    const liveSources = [
      [{ source: 'streamedpk', id: '1' }],
      [{ source: 'daddylive', id: '2' }],
      [{ source: 'streamsports99', id: '3' }],
      [{ source: 'watchfooty', id: '4' }]
    ];

    for (const src of liveSources) {
      const pastEvent = {
        id: 'past-match',
        title: 'Team A vs Team B',
        category: 'football',
        date: String(now - 4 * HOUR),
        status: 'finished',
        sources: src
      };
      expect(isReplayMatch(pastEvent)).toBe(false);
    }

    const rzEvent = {
      id: 'rz-match',
      title: 'Team A vs Team B - Full Game Replay',
      category: 'football',
      date: String(now - 4 * HOUR),
      status: 'finished',
      sources: [{ source: 'replayzone', id: 'url', url: 'url' }]
    };
    expect(isReplayMatch(rzEvent)).toBe(true);
  });

  test('a baseball match starting in 10 minutes is NOT live', () => {
    const upcomingBaseball = {
      id: 'ss99_2581863',
      title: 'Cincinnati Reds vs Chicago Cubs',
      category: 'baseball',
      status: 'upcoming',
      date: String(now + 10 * 60 * 1000),
      sources: [{ source: 'streamsports99', id: '2581863' }]
    };
    expect(isMatchLive(upcomingBaseball)).toBe(false);
  });

  test('a match with status "upcoming" starting in future is NOT live', () => {
    const futureUpcoming = {
      id: 'upcoming-future-1',
      title: 'Team A vs Team B',
      category: 'football',
      status: 'upcoming',
      date: String(now + 15 * 60 * 1000),
      sources: [{ source: 'daddylive', id: '1' }]
    };
    expect(isMatchLive(futureUpcoming)).toBe(false);
  });

  test('getKickoff parses "YYYY-MM-DD HH:mm" as UTC', () => {
    const epoch = getKickoff('2026-09-18 22:40');
    expect(new Date(epoch).toISOString()).toBe('2026-09-18T22:40:00.000Z');
  });
});
