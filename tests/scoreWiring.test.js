'use strict';

/**
 * Score wiring: provider -> MatchEntity -> aggregator -> catalog -> card/description.
 *
 * The score only exists because LiveTVProvider already parses it; these tests
 * pin every hop so it cannot be dropped again, and pin the guard rails that stop
 * a score leaking onto an upcoming fixture or a 24/7 channel.
 */

const { mapMatchToMetaPreview } = require('../src/catalog');
const MatchEntity = require('../src/domain/MatchEntity');

const MINUTE = 60 * 1000;

/** A live fixture with no provider artwork, i.e. the composed-card path. */
function liveMatch(overrides = {}) {
  return {
    id: 'score-test-1',
    title: 'Valencia - Real Sociedad',
    category: 'football',
    league: 'La Liga',
    date: String(Date.now() - 20 * MINUTE),
    status: '',
    score: '2:3',
    popular: '0',
    sources: [{ source: 'livetv', id: 'x', name: 'Server 1', url: 'https://example.com/x', type: 'iframe' }],
    thumbnail_url: '',
    poster: '',
    logo: '',
    background: '',
    team1: { name: 'Valencia' },
    team2: { name: 'Real Sociedad' },
    ...overrides
  };
}

const statusLine = (meta) => (meta.description || '').split('\n').find((l) => /Status:/.test(l)) || '';

describe('MatchEntity carries the score', () => {
  test('a provider score string survives construction', () => {
    expect(new MatchEntity({ score: '2:1' }).score).toBe('2:1');
  });

  test('a missing score stays an empty string, not "undefined"', () => {
    expect(new MatchEntity({}).score).toBe('');
    expect(new MatchEntity({ score: null }).score).toBe('');
    expect(new MatchEntity({ score: undefined }).score).toBe('');
  });

  test('a numeric zero score is preserved rather than coerced away', () => {
    expect(new MatchEntity({ score: 0 }).score).toBe('0');
  });
});

describe('score reaches the composed match card', () => {
  test('sc is forwarded to /img/match when artwork is absent', () => {
    const meta = mapMatchToMetaPreview(liveMatch(), {});
    expect(meta.poster).toContain('/img/match?');
    expect(new URL(meta.poster, 'http://x').searchParams.get('sc')).toBe('2:3');
  });

  test('the provider-artwork path is unaffected by the score', () => {
    const meta = mapMatchToMetaPreview(
      liveMatch({ thumbnail_url: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png' }),
      {}
    );
    expect(meta.poster).toContain('/img?url=');
    expect(meta.poster).not.toContain('sc=');
  });
});

describe('score reaches the description status line', () => {
  test('a live match renders the score in parentheses', () => {
    expect(statusLine(mapMatchToMetaPreview(liveMatch(), {}))).toContain('(2:3)');
  });

  test('the score appears regardless of which poster path was taken', () => {
    const withArt = mapMatchToMetaPreview(
      liveMatch({ thumbnail_url: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png' }),
      {}
    );
    expect(statusLine(withArt)).toContain('(2:3)');
  });

  test('a match with no score renders a clean status line', () => {
    const line = statusLine(mapMatchToMetaPreview(liveMatch({ score: '' }), {}));
    expect(line).toContain('LIVE NOW');
    expect(line).not.toContain('(');
    expect(line).not.toContain('undefined');
  });

  test('24/7 channels never show a score even if one is present', () => {
    const meta = mapMatchToMetaPreview(
      liveMatch({ category: 'networks', title: 'CNN', score: '2:3', team1: null, team2: null }),
      {}
    );
    expect(statusLine(meta)).not.toContain('2:3');
    expect(statusLine(meta)).toContain('24/7');
  });

  test('an upcoming fixture does not claim to be live', () => {
    const meta = mapMatchToMetaPreview(
      liveMatch({ date: String(Date.now() + 6 * 60 * MINUTE), score: '', status: '' }),
      {}
    );
    expect(statusLine(meta)).toContain('Kickoff');
    expect(statusLine(meta)).not.toContain('2:3');
  });
});

describe('generated date posters replace the repeated sport JPEG', () => {
  test('the date list uses distinct generated cards for consecutive dates', async () => {
    const container = require('../src/container');
    const { handleCatalog } = require('../src/catalog');
    
    // Prevent background syncs from overwriting the cache during this test
    container.resolve('matchAggregator').syncMatches = async () => [];
    container.resolve('cronService').isSyncing = true; // block ensureFresh

    const day = (offset) => new Date(Date.now() - offset * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    const matches = [0, 1, 2].map((i) => ({
      id: 'rz_fb_' + i,
      title: 'Team ' + i + ' vs Rival ' + i,
      category: 'football',
      league: 'Premier League',
      date: day(i),
      status: 'finished',
      sources: [{ source: 'replayzone', id: 'https://ok.ru/video/' + i, url: 'https://ok.ru/video/' + i }]
    }));

    container.resolve('cacheService').setMatches(matches);
    const res = await handleCatalog('tv', 'nuvio_sports_replays', {}, {});
    const posters = (res.metas || []).map((m) => m.poster).filter((p) => p && p.includes('/img/date'));

    expect(posters.length).toBeGreaterThanOrEqual(2);
    // Each date must be its own asset, not one shared sport cover.
    expect(new Set(posters).size).toBe(posters.length);
    for (const p of posters) {
      expect(new URL(p).searchParams.get('shape')).toBe('poster');
      expect(p).not.toContain('/posters/replays/');
    }
  });
});
