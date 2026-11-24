'use strict';

const KafkaProvider = require('../src/providers/KafkaProvider');

const NOW = Date.UTC(2026, 10, 23, 19, 0);

function providerWith(candidates) {
  return new KafkaProvider({
    catalogStore: {
      isReady: () => true,
      findTeam: () => [],
      findChannel: () => candidates
    },
    eventSearch: { isInWindow: () => true, cachedFor: () => [] }
  });
}

function fixtureWith(label) {
  return {
    id: 'f1',
    date: NOW + 600000,
    team1: { name: 'Los Angeles Lakers' },
    team2: { name: 'Utah Jazz' },
    sources: [{ source: 'daddylive', id: '1', channelName: label, countryCode: 'US' }]
  };
}

describe('Kafka source display label', () => {
  test('drops the catalog routing group from the name and keeps the country', () => {
    const provider = providerWith([{ id: 'trex:nba-us', name: 'US| NBA TV HD', group: 'US', score: 3000 }]);

    const [source] = provider.createSourcesForFixture(fixtureWith('NBA TV USA'), { now: NOW });

    expect(source.channelName).toBe('NBA TV HD');
    expect(source.country).toBe('United States');
  });

  test('a club channel loses its league prefix and claims no country', () => {
    const provider = new KafkaProvider({
      catalogStore: {
        isReady: () => true,
        findTeam: () => [{ id: 'trex:lakers', name: 'NBA TEAM| LOS ANGELES LAKERS', group: 'NBA TEAM', league: 'nba', score: 3000 }],
        findChannel: () => []
      },
      eventSearch: { isInWindow: () => true, cachedFor: () => [] }
    });

    const [source] = provider.createSourcesForFixture(
      { id: 'f1', date: NOW + 600000, team1: { name: 'Los Angeles Lakers' }, team2: { name: 'Utah Jazz' }, sources: [] },
      { now: NOW }
    );

    expect(source.channelName).toBe('LOS ANGELES LAKERS');
    expect(source.country).toBeUndefined();
  });

  test('a market prefix becomes the right country instead of the guessed one', () => {
    const provider = providerWith([{ id: 'trex:nba-tr', name: 'TR| NBA TV 4K', group: 'TR', score: 3100 }]);

    const [source] = provider.createSourcesForFixture(fixtureWith('Vavoo NBA TV'), { now: NOW });

    expect(source.channelName).toBe('NBA TV 4K');
    expect(source.country).toBe('Turkey');
  });
});
