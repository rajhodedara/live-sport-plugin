'use strict';

const { TrexEventSearch } = require('../src/services/TrexEventSearch');

const NOW = Date.UTC(2026, 10, 23, 19, 0);
const BASE = 'https://trex.invalid/base';

const FIXTURE = {
  id: 'f1',
  date: String(NOW + 600000),
  team1: { name: 'Wofford' },
  team2: { name: 'Wake Forest' }
};

const METAS = [
  {
    id: 'trex:1',
    name: 'NEXT | WOFFORD VS. WAKE FOREST | Mon 23 Nov 23:55 CET (SE) | 8K EXCLUSIVE | SE: PLAY+ PPV 19'
  },
  {
    id: 'trex:2',
    name: 'US (ESPN+ 073) | NCAA Women`s Basketball: Wofford vs. Wake Forest (Wofford vs. Wake Forest) (2026-11-23 18:00:40)'
  },
  { id: 'trex:3', name: 'ESPN+: Queens vs. Wofford (Queens vs. Wofford) (2026-11-24 18:00:55)' }
];

function jsonResponse(metas) {
  return { ok: true, status: 200, json: async () => ({ metas }) };
}

function decode(url) {
  return decodeURIComponent(String(url));
}

function ids(candidates) {
  return candidates.map((candidate) => candidate.id);
}

describe('event-first discovery', () => {
  const flag = process.env.KAFKA_EVENT_FIRST_ENABLED;
  beforeEach(() => { process.env.KAFKA_EVENT_FIRST_ENABLED = 'true'; });
  afterEach(() => {
    if (flag === undefined) delete process.env.KAFKA_EVENT_FIRST_ENABLED;
    else process.env.KAFKA_EVENT_FIRST_ENABLED = flag;
  });
  const game = { id: 'bos-was', date: NOW - 57 * 60000, category: 'basketball', league: 'NBA',
    team1: 'Boston Celtics', team2: 'Washington Wizards' };

  test('keeps live overtime and enforces the clock boundaries and terminal states', () => {
    const s = new TrexEventSearch({ now: () => NOW });
    expect(s.isFixtureSearchable(game)).toBe(true);
    expect(s.isFixtureSearchable({ ...game, date: new Date(NOW + 15 * 60000).toISOString() })).toBe(true);
    expect(s.isFixtureSearchable({ ...game, date: NOW + 15 * 60000 + 1 })).toBe(false);
    expect(s.isFixtureSearchable({ ...game, date: NOW - 4 * 3600000 })).toBe(true);
    expect(s.isFixtureSearchable({ ...game, date: NOW - 4 * 3600000 - 1 })).toBe(false);
    expect(s.isFixtureSearchable({ ...game, date: NOW - 5 * 3600000, status: 'live' })).toBe(true);
    expect(s.isFixtureSearchable({ ...game, status: 'finished' })).toBe(false);
    expect(s.isFixtureSearchable({ ...game, status: 'live', isReplay: true })).toBe(false);
    expect(s.isFixtureSearchable({ ...game, date: null })).toBe(false);
  });

  test('20 viewers and a sweep share both alias requests, one abort leaves the other viewers attached', async () => {
    const metas = Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: 'Live | Celtics vs. Wizards | NBA | Feed ' + i }));
    let finish;
    const fetchImpl = jest.fn()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(jsonResponse([]));
    const s = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });
    const abort = new AbortController();
    const canceled = s.findForFixture(game, { signal: abort.signal });
    const viewers = Array.from({ length: 19 }, () => s.findForFixture(game));
    const sweep = s.sweep([game]);
    abort.abort();
    await expect(canceled).resolves.toEqual([]);
    expect(decode(fetchImpl.mock.calls[0][0])).toContain('/search=celtics.json');
    finish(jsonResponse(metas));
    expect((await Promise.all(viewers)).every(rows => rows.length === 6)).toBe(true);
    expect((await sweep).get(game.id)).toHaveLength(6);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(s.stats).toEqual({ requests: 2, shared: 20, sweepRequests: 0 });
    expect(s.cachedFor(game)).toHaveLength(6);
    expect(s.cachedFor({ ...game, date: game.date + 86400000 })).toEqual([]);
  });

  test('never exceeds two upstream searches across fixtures and counts retries within a sweep', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = jest.fn(async () => {
      peak = Math.max(++active, peak);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return jsonResponse([]);
    });
    const s = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });
    const fixtures = Array.from({ length: 30 }, (_, i) => ({ ...game, id: String(i) }));
    await Promise.all([s.sweep(fixtures, { maxSearches: 20 }), s.findForFixture(game)]);
    expect(peak).toBe(2);
    expect(s.stats.sweepRequests).toBe(20);
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(22);
  });

  test('a failed fetch can retry; nickname and full-name queries merge, validate both opponents and dedupe', async () => {
    const aliasHit = { id: 'a', name: 'Live | Celtics vs. Wizards' };
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce(jsonResponse([aliasHit, { id: 'x', name: 'Live | Celtics vs. Nuggets' }]))
      .mockResolvedValueOnce(jsonResponse([aliasHit, { id: 'b', name: 'Next | Washington Wizards vs. Boston Celtics' }]));
    const s = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });
    await expect(s.findForFixture(game)).resolves.toEqual([]);
    expect(ids(await s.findForFixture(game))).toEqual(['a', 'b']);
    expect(fetchImpl.mock.calls.map(([url]) => decode(url).split('search=')[1]))
      .toEqual(['celtics.json', 'celtics.json', 'boston celtics.json']);
  });

  test('searches localized short aliases and bare cities for soccer fixtures', async () => {
    const fetchImpl = jest.fn(async (url) => {
      const q = decode(url).split('search=')[1];
      if (q === 'bayern.json') return jsonResponse([{ id: 's1', name: 'Next | Lille x Bayern | UEFA Champions League | 2026-11-23 | 20:00 (GMT)' }]);
      if (q === 'portland.json') return jsonResponse([{ id: 's2', name: '(Apple) (MLS) 027 |  Portland vs. Dallas  (2026-11-23 20:10:00)' }]);
      return jsonResponse([]);
    });
    const s = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });

    const bayern = await s.findForFixture({
      id: 'ucl-bayern', date: NOW + 600_000, category: 'football', league: 'UCL',
      team1: 'FC Bayern Munich', team2: 'LOSC Lille'
    });
    expect(ids(bayern)).toEqual(['s1']);

    const portland = await s.findForFixture({
      id: 'mls-por', date: NOW + 600_000, category: 'football', league: 'MLS',
      team1: 'Portland Timbers', team2: 'FC Dallas'
    });
    expect(ids(portland)).toEqual(['s2']);
    expect(fetchImpl.mock.calls.map(([u]) => decode(u).split('search=')[1]))
      .toEqual(['bayern munich.json', 'bayern.json', 'portland timbers.json', 'portland.json']);
  });

  test('keeps more than six distinct matches across both alias queries and retries after partial upstream failure', async () => {
    const aliasOneMetas = Array.from({ length: 7 }, (_, i) => ({
      id: `trex:a1-${i + 1}`,
      name: `Live | Celtics vs. Wizards | Feed ${i + 1}`
    }));
    aliasOneMetas.push({ id: 'trex:wrong', name: 'Live | Celtics vs. Heat' });
    const aliasTwoMetas = [
      aliasOneMetas[0],
      { id: 'trex:a2-1', name: 'Next | Washington Wizards vs. Boston Celtics | Feed 8' },
      { id: 'trex:a2-2', name: 'Next | Boston Celtics vs. Washington Wizards | Feed 9' }
    ];

    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(aliasOneMetas))
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce(jsonResponse(aliasOneMetas))
      .mockResolvedValueOnce(jsonResponse(aliasTwoMetas));

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });
      const partial = await s.findForFixture(game);
      expect(ids(partial)).toHaveLength(7);
      expect(ids(partial)).not.toContain('trex:wrong');

      const complete = await s.findForFixture(game);
      expect(ids(complete)).toHaveLength(9);
      expect(ids(complete)).toContain('trex:a2-1');
      expect(ids(complete)).toContain('trex:a2-2');
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  test('matches NHL zoned ET titles and blocks wrong-sport, multi-match, December 3, and out-of-window kickoffs', async () => {
    const nhlMetas = [
      { id: '1949763', name: 'US (ESPN+ 149) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:00)' },
      { id: '1949760', name: 'US (ESPN+ 152) | Utah Mammoth vs. Minnesota Wild Nov 25 7:30PM ET (2026-11-25 19:30:15)' },
      { id: 'nba:uta-min', name: 'NBA | UTA vs MIN (2026-11-25 19:30:00)' },
      { id: 'nba:utah-minn', name: 'NBA | Utah vs. Minnesota (2026-11-25 19:30:00)' },
      { id: 'nhl:multi-bullet', name: 'Live | Utah Mammoth vs. Minnesota Wild \u2022 Oilers vs. Flames (2026-11-25 19:30:00)' },
      { id: 'nhl:multi-pipe', name: 'NHL | Utah Mammoth vs. Minnesota Wild | Oilers vs. Flames' }
    ];
    const fetchImpl = jest.fn(async (url) => {
      const q = decode(url).split('search=')[1];
      if (q === 'mammoth.json') return jsonResponse(nhlMetas);
      return jsonResponse([]);
    });

    const nov26 = Date.UTC(2026, 10, 26, 1, 0);
    const searchNov26 = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => nov26 });
    const hits = await searchNov26.findForFixture({
      id: 'nhl-uta-min-nov26',
      date: '2026-11-26T01:00:00Z',
      category: 'hockey',
      league: 'NHL',
      team1: 'Utah Mammoth',
      team2: 'Minnesota Wild'
    });
    expect(ids(hits)).toEqual(expect.arrayContaining(['1949763', '1949760']));
    expect(ids(hits)).toHaveLength(2);

    const sameDayLate = Date.UTC(2026, 10, 26, 12, 0);
    const searchLate = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => sameDayLate });
    await expect(searchLate.findForFixture({
      id: 'nhl-uta-min-late',
      date: '2026-11-26T12:00:00Z',
      category: 'hockey',
      league: 'NHL',
      team1: 'Utah Mammoth',
      team2: 'Minnesota Wild'
    })).resolves.toEqual([]);

    const dec03 = Date.UTC(2026, 11, 3, 1, 0);
    const searchDec03 = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => dec03 });
    await expect(searchDec03.findForFixture({
      id: 'nhl-uta-min-dec03',
      date: '2026-12-03T01:00:00Z',
      category: 'hockey',
      league: 'NHL',
      team1: 'Utah Mammoth',
      team2: 'Minnesota Wild'
    })).resolves.toEqual([]);
  });
});

describe('TrexEventSearch', () => {
  test('accepts kickoffs from 15 minutes before to 4 hours after now', () => {
    const search = new TrexEventSearch({ baseUrl: BASE, now: () => NOW, fetchImpl: jest.fn() });

    expect(search.isInWindow(NOW - 14 * 60000)).toBe(true);
    expect(search.isInWindow(NOW - 16 * 60000)).toBe(false);
    expect(search.isInWindow(NOW + 4 * 3600000 - 1)).toBe(true);
    expect(search.isInWindow(NOW + 4 * 3600000 + 1)).toBe(false);
  });

  test('ranks 8K first, keeps only listings naming the other team, and caches the result', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(decode(url));
      return jsonResponse(METAS);
    };
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });

    const first = await search.findForFixture(FIXTURE);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/catalog/tv/flix-live-tv-v2-trex/search=wofford.json');
    expect(ids(first)).toEqual(['trex:1', 'trex:2']);
    expect(first[0].score).toBeGreaterThan(first[1].score);
    expect(first[0]).toMatchObject({ id: 'trex:1', group: expect.any(String) });

    const second = await search.findForFixture(FIXTURE);

    expect(calls).toHaveLength(1);
    expect(ids(second)).toEqual(['trex:1', 'trex:2']);
    expect(ids(search.cachedFor('f1'))).toEqual(['trex:1', 'trex:2']);
  });

  test('keeps at most two candidates when three listings match', async () => {
    const metas = [
      ...METAS.slice(0, 2),
      { id: 'trex:4', name: 'ESPN3 | Wofford vs. Wake Forest (2026-11-23 18:00)' }
    ];
    const search = new TrexEventSearch({
      baseUrl: BASE,
      fetchImpl: async () => jsonResponse(metas),
      now: () => NOW
    });

    expect(ids(await search.findForFixture(FIXTURE))).toHaveLength(2);
  });

  test('serves nothing for an unknown or expired fixture id', async () => {
    let clock = NOW;
    const fetchImpl = async () => jsonResponse(METAS);
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, ttlMs: 600000, now: () => clock });

    expect(search.cachedFor('nope')).toEqual([]);

    await search.findForFixture(FIXTURE);
    expect(ids(search.cachedFor('f1'))).toEqual(['trex:1', 'trex:2']);

    clock = NOW + 600000;
    expect(search.cachedFor('f1')).toEqual([]);
  });

  test('evicts the oldest cache entry above maxEntries', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(METAS);
    };
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW, maxEntries: 1 });

    await search.findForFixture({ ...FIXTURE, id: 'a' });
    await search.findForFixture({ ...FIXTURE, id: 'b' });

    expect(calls).toBe(2);
    expect(search.cachedFor('a')).toEqual([]);
    expect(ids(search.cachedFor('b'))).toEqual(['trex:1', 'trex:2']);
  });

  test('force skips a warm cache and costs one extra request', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(METAS);
    };
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });

    await search.findForFixture(FIXTURE);
    await search.findForFixture(FIXTURE);
    expect(calls).toBe(1);

    expect(ids(await search.findForFixture(FIXTURE, { force: true }))).toEqual(['trex:1', 'trex:2']);
    expect(calls).toBe(2);
  });

  test('retries once without the last token when the query finds nothing', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const decoded = decode(url);
      calls.push(decoded);
      if (decoded.includes('search=east carolina pirates.json')) return jsonResponse([]);
      if (decoded.includes('search=east carolina.json')) {
        return jsonResponse([{ id: 'trex:9', name: 'NEXT | INDIANA STATE VS. EAST CAROLINA | 8K EXCLUSIVE' }]);
      }
      return jsonResponse([]);
    };
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });

    const found = await search.findForFixture({
      id: 'f2',
      date: String(NOW + 3600000),
      team1: { name: 'East Carolina Pirates' },
      team2: { name: 'Indiana State' }
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('search=east carolina pirates.json');
    expect(calls[1]).toContain('search=east carolina.json');
    expect(ids(found)).toEqual(['trex:9']);
  });

  test('counts a trim-and-retry against the sweep budget and stops the walk', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const decoded = decode(url);
      calls.push(decoded);
      if (decoded.includes('search=east carolina pirates.json')) return jsonResponse([]);
      if (decoded.includes('search=east carolina.json')) {
        return jsonResponse([{ id: 'trex:9', name: 'NEXT | INDIANA STATE VS. EAST CAROLINA | 8K EXCLUSIVE' }]);
      }
      return jsonResponse([{ id: 'trex:other', name: 'NEXT | OTHER VS. RIVALS | 8K EXCLUSIVE' }]);
    };
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW, concurrency: 1 });

    const results = await search.sweep([
      { id: 'f2', date: String(NOW + 60000), team1: { name: 'East Carolina Pirates' }, team2: { name: 'Indiana State' } },
      { id: 'f3', date: String(NOW + 120000), team1: { name: 'Alpha' }, team2: { name: 'Rivals' } },
      { id: 'f4', date: String(NOW + 180000), team1: { name: 'Beta' }, team2: { name: 'Rivals' } }
    ], { maxSearches: 2 });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('search=east carolina pirates.json');
    expect(calls[1]).toContain('search=east carolina.json');
    expect(calls.some((call) => call.includes('search=alpha.json'))).toBe(false);
    expect(ids(results.get('f2'))).toEqual(['trex:9']);
    expect(results.get('f3')).toEqual([]);
    expect(results.get('f4')).toEqual([]);
  });

  test('returns an empty list on a 502, caches nothing, and retries on the next call', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let fail = true;
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return fail ? { ok: false, status: 502, json: async () => ({}) } : jsonResponse(METAS);
      };
      const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW });

      expect(await search.findForFixture(FIXTURE)).toEqual([]);
      expect(search.cachedFor('f1')).toEqual([]);
      expect(warn).toHaveBeenCalledWith('[TrexEventSearch] search failed: HTTP_502');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('trex.invalid');

      fail = false;
      expect(ids(await search.findForFixture(FIXTURE))).toEqual(['trex:1', 'trex:2']);
      expect(calls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  test('discards a response body larger than 512 KB', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const search = new TrexEventSearch({
        baseUrl: BASE,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'x'.repeat(512 * 1024 + 1) }),
        now: () => NOW
      });

      expect(await search.findForFixture(FIXTURE)).toEqual([]);
      expect(search.cachedFor('f1')).toEqual([]);
      expect(warn).toHaveBeenCalledWith('[TrexEventSearch] search failed: BODY_TOO_LARGE');
    } finally {
      warn.mockRestore();
    }
  });

  test('stops reading a streamed body at the 512 KB cap', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let pulls = 0;
      const body = new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls > 10) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(200 * 1024).fill(120));
        }
      });
      const search = new TrexEventSearch({
        baseUrl: BASE,
        fetchImpl: async () => ({ ok: true, status: 200, body }),
        now: () => NOW
      });

      expect(await search.findForFixture(FIXTURE)).toEqual([]);
      expect(search.cachedFor('f1')).toEqual([]);
      expect(warn).toHaveBeenCalledWith('[TrexEventSearch] search failed: BODY_TOO_LARGE');
      expect(pulls).toBeGreaterThanOrEqual(3);
      expect(pulls).toBeLessThan(10);
    } finally {
      warn.mockRestore();
    }
  });

  test('sweeps the live window nearest kickoff first and stops at the search budget', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(decode(url));
      return jsonResponse([{ id: 'trex:sweep', name: 'NEXT | RIVALS VS. CHALLENGERS | 8K EXCLUSIVE' }]);
    };
    const search = new TrexEventSearch({ baseUrl: BASE, fetchImpl, now: () => NOW, concurrency: 2 });

    const matches = Array.from({ length: 30 }, (_, index) => ({
      id: `fx${index}`,
      date: String(NOW + (index + 1) * 60000),
      team1: { name: `Alpha${index}` },
      team2: { name: 'Rivals' }
    }));
    matches.push({ id: 'far', date: String(NOW + 5 * 3600000), team1: { name: 'Later' }, team2: { name: 'Rivals' } });

    const results = await search.sweep(matches, { maxSearches: 20 });

    expect(calls).toHaveLength(20);
    expect(calls[0]).toContain('search=alpha0.json');
    expect(calls[19]).toContain('search=alpha19.json');
    expect(results.size).toBe(30);
    expect(results.has('far')).toBe(false);
    expect(ids(results.get('fx0'))).toEqual(['trex:sweep']);
    expect(results.get('fx25')).toEqual([]);
  });
});
