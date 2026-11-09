'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  collectTeamNames,
  MAX_TEAMS,
  MAX_NAME_LENGTH,
} = require('../src/services/TeamSuggestions');

const match = (home, away) => ({
  team1: home ? { name: home } : null,
  team2: away ? { name: away } : null,
});

describe('collectTeamNames', () => {
  test('orders by how many fixtures name the team, then alphabetically', () => {
    const names = collectTeamNames([
      match('Arsenal', 'Chelsea'),
      match('Arsenal', 'Spurs'),
      match('Chelsea', 'Arsenal'),
      match('Spurs', 'Fulham'),
    ]);
    expect(names).toEqual(['Arsenal', 'Chelsea', 'Spurs', 'Fulham']);
  });

  test('trims names and drops blanks, duplicates within one match collapse', () => {
    expect(collectTeamNames([match('  Arsenal  ', null), match('', 'Chelsea')])).toEqual(['Arsenal', 'Chelsea']);
    expect(collectTeamNames([match('Arsenal', 'Arsenal')])).toEqual(['Arsenal']);
  });

  test('ignores team slots that are not name objects', () => {
    const names = collectTeamNames([
      { team1: 'Arsenal', team2: { name: 'Chelsea' } },
      { team1: { logo: 'x.png' }, team2: null },
      { team1: { name: 42 } },
      null,
    ]);
    expect(names).toEqual(['Chelsea']);
  });

  test('drops names longer than the limit instead of truncating them', () => {
    const long = 'A'.repeat(MAX_NAME_LENGTH + 1);
    const atLimit = 'B'.repeat(MAX_NAME_LENGTH);
    expect(collectTeamNames([match(long, atLimit)])).toEqual([atLimit]);
  });

  test('caps the list at MAX_TEAMS', () => {
    const many = Array.from({ length: MAX_TEAMS + 120 }, (_, i) => match('Team ' + i, null));
    expect(collectTeamNames(many)).toHaveLength(MAX_TEAMS);
  });

  test('honours an explicit limit', () => {
    const names = collectTeamNames([match('A', 'B'), match('C', 'D')], { limit: 2 });
    expect(names).toHaveLength(2);
  });

  test('tolerates an empty or missing cache', () => {
    expect(collectTeamNames([])).toEqual([]);
    expect(collectTeamNames(null)).toEqual([]);
    expect(collectTeamNames(undefined)).toEqual([]);
  });
});

describe('/api/options team suggestions wiring', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  test('options endpoint fills teams from the cached fixtures', () => {
    const start = index.indexOf("app.get('/api/options'");
    expect(start).toBeGreaterThan(-1);
    const nextRoute = index.indexOf('app.get(', start + 10);
    const routeBlock = index.slice(start, nextRoute === -1 ? undefined : nextRoute);
    expect(routeBlock).toContain('teams = collectTeamNames(cached)');
    expect(routeBlock).toContain('teams,');
  });
});
