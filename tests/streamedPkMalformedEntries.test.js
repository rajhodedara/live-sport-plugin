'use strict';
const StreamedPkProvider = require('../src/providers/StreamedPkProvider');

function createProvider() {
  const circuitBreaker = {
    wrapSync: () => ({ fire: jest.fn() }),
    wrap: () => ({ fire: jest.fn() }),
  };
  return new StreamedPkProvider({ circuitBreaker });
}

describe('StreamedPk malformed entries', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());
  test('one malformed match or source does not prevent later matches', async () => {
    const provider = createProvider();
    provider.fetchLiveMatches.fire.mockResolvedValue([]);
    provider.fetchMatches.fire.mockResolvedValue([
      null,
      { id: 'one', title: 'One', sources: [null, { id: 's1', source: 'alpha' }] },
      { id: 'two', title: 'Two', sources: 'bad' },
      { id: 'three', title: 'Three', sources: [{ id: 's3', source: 'bravo' }] },
    ]);
    const matches = await provider.getMatches();
    expect(matches.map(m => m.title)).toEqual(['One', 'Two', 'Three']);
    expect(matches[0].sources).toEqual([expect.objectContaining({ streamSource: 'alpha', streamId: 's1' })]);
    expect(matches[1].sources).toEqual([expect.objectContaining({ id: 'two' })]);
  });
  test('a malformed stream entry does not prevent a valid fallback', async () => {
    const provider = createProvider();
    provider.fetchStreams.fire.mockResolvedValue([null, { embedUrl: 'https://example.com/player', viewers: 1 }]);
    const streams = await provider.resolveStream('event', '', 'Game');
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain('https%3A%2F%2Fexample.com%2Fplayer');
  });
});
