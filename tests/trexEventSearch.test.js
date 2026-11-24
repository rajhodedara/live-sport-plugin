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
