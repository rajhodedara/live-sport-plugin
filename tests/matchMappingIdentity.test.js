'use strict';

const MatchAggregator = require('../src/services/MatchAggregator');

const kickoff = () => String(Date.now() + 3600000);
const fixture = (title, extras = {}) => ({
  id: 'provider-a-event', title, category: 'football', date: kickoff(),
  sources: [{ source: 'provider-a', id: 'source-a' }], ...extras
});

describe('event mapping preserves explicit squad identity', () => {
  const agg = new MatchAggregator({});

  test.each([
    ['Arsenal Women vs Chelsea Women', 'Arsenal vs Chelsea'],
    ['Arsenal Women vs Chelsea Women', 'Arsenal Men vs Chelsea Men'],
    ['Arsenal U21 vs Chelsea U21', 'Arsenal vs Chelsea'],
    ['Arsenal U19 vs Chelsea U19', 'Arsenal U21 vs Chelsea U21'],
    ['Arsenal Reserves vs Chelsea Reserves', 'Arsenal vs Chelsea'],
    ['Arsenal II vs Chelsea II', 'Arsenal vs Chelsea'],
    ['Arsenal B vs Chelsea B', 'Arsenal First Team vs Chelsea First Team']
  ])('keeps %s separate from %s in both orders', (left, right) => {
    const a = fixture(left), b = fixture(right, { id: 'provider-b-event' });
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test.each([
    ['Arsenal vs Chelsea', 'Arsenal FC vs Chelsea FC'],
    ['Arsenal Women vs Chelsea Women', "Arsenal Women's vs Chelsea Women's"],
    ['Arsenal U21 vs Chelsea U21', 'Arsenal Under-21 vs Chelsea Under-21'],
    ['Arsenal Reserves vs Chelsea Reserves', 'Arsenal II vs Chelsea II'],
    ['Arsenal II - Chelsea II', 'Arsenal II vs Chelsea II'],
    ['Barcelona B vs Villarreal C', 'Barcelona B vs Villarreal C'],
    ['Barcelona B vs Villarreal C', 'Villarreal C vs Barcelona B']
  ])('retains compatible squad/club aliases: %s / %s', (left, right) => {
    const a = fixture(left), b = fixture(right, { id: 'provider-b-event' });
    expect(agg.isSameEvent(a, b)).toBe(true);
    expect(agg.isSameEvent(b, a)).toBe(true);
  });

  test('uses explicit league information when the title omits the squad label', () => {
    const women = fixture('Arsenal vs Chelsea', { league: "Women's Super League" });
    const unlabelled = fixture('Arsenal vs Chelsea', { id: 'other' });
    expect(agg.isSameEvent(women, unlabelled)).toBe(false);
    expect(agg.isSameEvent(unlabelled, women)).toBe(false);
    expect(agg.isSameEvent(women, fixture('Arsenal Women vs Chelsea Women', { id: 'other' }))).toBe(true);
  });

  test('uses explicit team metadata even if the listing title is unqualified', () => {
    const youth = fixture('Arsenal vs Chelsea', { team1: { name: 'Arsenal U19' }, team2: { name: 'Chelsea U19' } });
    const adult = fixture('Arsenal vs Chelsea', { id: 'other' });
    expect(agg.isSameEvent(youth, adult)).toBe(false);
    expect(agg.isSameEvent(adult, youth)).toBe(false);
  });

  test('an exact provider ID cannot bypass incompatible squad information', () => {
    const women = fixture('Arsenal Women vs Chelsea Women');
    const unlabelled = fixture('Arsenal vs Chelsea');
    expect(agg.isSameEvent(women, unlabelled)).toBe(false);
    expect(agg.isSameEvent(unlabelled, women)).toBe(false);
  });

  test('a reused provider ID cannot override two contradictory team pairs', () => {
    const a = fixture('Arsenal vs Chelsea');
    const b = fixture('Liverpool vs Everton');
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test('placeholder teams can be resolved under the same event ID', () => {
    const pending = fixture('TBA vs TBA');
    const known = fixture('Arsenal vs Chelsea');
    expect(agg.isSameEvent(pending, known)).toBe(true);
    expect(agg.isSameEvent(known, pending)).toBe(true);
  });

  test('squad levels must belong to the matching competitor, not just the event', () => {
    const a = fixture('Barcelona B vs Villarreal C');
    const b = fixture('Barcelona C vs Villarreal B', { id: 'other' });
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test.each([
    ['Arsenal B vs Chelsea', 'Arsenal vs Chelsea B'],
    ['Arsenal B vs Chelsea', 'Arsenal B vs Chelsea B'],
    ['Arsenal (W) vs Chelsea (W)', 'Arsenal vs Chelsea'],
    ['Arsenal (B) vs Chelsea (B)', 'Arsenal vs Chelsea']
  ])('participant labels stay attached: %s / %s', (left, right) => {
    const a = fixture(left), b = fixture(right, { id: 'other' });
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test('participant metadata cannot migrate to the other team', () => {
    const a = fixture('Arsenal vs Chelsea', { team1: { name: 'Arsenal U21' }, team2: { name: 'Chelsea' } });
    const b = fixture('Arsenal vs Chelsea', { id: 'other', team1: { name: 'Arsenal' }, team2: { name: 'Chelsea U21' } });
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test('reused exact IDs still respect the existing date window', () => {
    const a = fixture('Arsenal vs Chelsea');
    const b = fixture('Arsenal vs Chelsea', { date: String(Number(a.date) + 2 * 86400000) });
    expect(agg.isSameEvent(a, b)).toBe(false);
    expect(agg.isSameEvent(b, a)).toBe(false);
  });

  test('explicit basketball gender categories stay separate after category normalization', () => {
    const women = fixture('New York vs Chicago', { category: 'wnba' });
    const men = fixture('New York vs Chicago', { id: 'other', category: 'nba' });
    expect(agg.isSameEvent(women, men)).toBe(false);
    expect(agg.isSameEvent(men, women)).toBe(false);
  });
});

describe('source associations through the actual aggregation path', () => {
  let log;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { log.mockRestore(); });

  async function sync(rows) {
    let saved;
    const cacheService = { getMatchesReadOnly: () => [], setMatches: matches => { saved = matches; } };
    const agg = new MatchAggregator({
      cacheService,
      yamlProviders: rows.map((row, index) => ({ sourceName: `provider-${index}`, getMatches: async () => [row] }))
    });
    await agg.syncMatches();
    return saved;
  }

  test.each([false, true])('a shared alias does not attach youth sources to the unqualified fixture (reverse=%s)', async reverse => {
    const a = fixture('Arsenal vs Chelsea', { aliasIds: ['shared-listing'] });
    const b = fixture('Arsenal U21 vs Chelsea U21', {
      id: 'provider-b-event', aliasIds: ['shared-listing'],
      sources: [{ source: 'provider-b', id: 'source-b' }]
    });
    const rows = await sync(reverse ? [b, a] : [a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.title === a.title).sources.map(s => s.id)).toEqual(['source-a']);
    expect(rows.find(row => row.title === b.title).sources.map(s => s.id)).toEqual(['source-b']);
  });

  test('compatible women aliases still combine sources into one fixture', async () => {
    const a = fixture('Arsenal Women vs Chelsea Women');
    const b = fixture("Arsenal Women's vs Chelsea Women's", {
      id: 'provider-b-event', sources: [{ source: 'provider-b', id: 'source-b' }]
    });
    const rows = await sync([a, b]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sources.map(s => s.id)).toEqual(['source-a', 'source-b']);
  });

  test('merging a fixture retains sources with different explicit country context', async () => {
    const source = { source: 'provider-a', id: 'same', channelName: 'Sky Sport F1' };
    const a = fixture('Arsenal vs Chelsea', { sources: [{ ...source, countryCode: 'IT' }] });
    const b = fixture('Arsenal vs Chelsea', { id: 'other', sources: [{ ...source, countryCode: 'DE' }] });
    const rows = await sync([a, b]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sources.map(s => s.countryCode)).toEqual(['IT', 'DE']);
  });

  test('a reserve label on one participant never attaches the opposite fixture sources', async () => {
    const a = fixture('Barcelona B vs Villarreal');
    const b = fixture('Barcelona vs Villarreal B', { id: 'other', sources: [{ source: 'provider-b', id: 'opposite-reserve' }] });
    const rows = await sync([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows.find(match => match.title === a.title).sources.map(s => s.id)).toEqual(['source-a']);
    expect(rows.find(match => match.title === b.title).sources.map(s => s.id)).toEqual(['opposite-reserve']);
  });

  test('broadcaster enrichment forwards each source country instead of collapsing it to a name', () => {
    const createVavooSource = jest.fn().mockReturnValue(null);
    const agg = new MatchAggregator({ broadcasterMatchService: { createVavooSource }, vavooProvider: { isEnabled: () => true } });
    const match = fixture('Arsenal vs Chelsea', { sources: [
      { source: 'one', id: 'a', channelName: 'Sky Sport F1', group: 'Italy' },
      { source: 'two', id: 'b', channelName: 'Sky Sport F1', countryCode: 'DE' }
    ] });
    agg._enrichMatchesWithBroadcasters([match]);
    expect(createVavooSource).toHaveBeenNthCalledWith(1, 'Sky Sport F1', { group: 'Italy', country: undefined, countryCode: undefined });
    expect(createVavooSource).toHaveBeenNthCalledWith(2, 'Sky Sport F1', { group: undefined, country: undefined, countryCode: 'DE' });
  });
});
