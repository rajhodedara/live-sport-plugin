'use strict';

const KafkaProvider = require('../src/providers/KafkaProvider');

const NOW = Date.UTC(2026, 10, 23, 19, 0);

function store() {
  return {
    isReady: () => true,
    findTeam: jest.fn(() => [{ id: 'trex:lakers', name: 'NBA TEAM| LOS ANGELES LAKERS', group: 'NBA TEAM', league: 'nba', score: 3000 }]),
    findChannel: jest.fn(() => [
      { id: 'trex:nba-us', name: 'US| NBA TV HD', group: 'US', score: 2000 },
      { id: 'trex:nba-tr', name: 'TR| NBA TV 4K', group: 'TR', score: 3100 }
    ])
  };
}

describe('KafkaProvider label candidates', () => {
  test('takes one source per broadcaster label, the store ranking decides which', () => {
    const provider = new KafkaProvider({
      catalogStore: store(),
      eventSearch: { isInWindow: () => true, cachedFor: () => [] }
    });

    const sources = provider.createSourcesForFixture(
      {
        id: 'f1',
        date: NOW + 600000,
        team1: { name: 'Los Angeles Lakers' },
        team2: { name: 'Utah Jazz' },
        sources: [{ source: 'daddylive', id: '1', channelName: 'NBA TV USA', countryCode: 'US' }]
      },
      { now: NOW }
    );

    expect(sources.map((source) => source.id)).toEqual(['trex:nba-us', 'trex:lakers']);
    expect(sources.map((source) => source.matchMode)).toEqual(['label', 'team']);
  });
});
