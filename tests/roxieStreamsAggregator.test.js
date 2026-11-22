const MatchAggregator = require('../src/services/MatchAggregator');

describe('MatchAggregator with RoxieStreams', () => {
  test('includes roxiestreamsProvider in active providers array when supplied', () => {
    const mockRoxie = {
      name: 'RoxieStreams',
      sourceName: 'roxiestreams',
      getMatches: jest.fn().mockResolvedValue([])
    };
    const aggregator = new MatchAggregator({
      roxiestreamsProvider: mockRoxie,
      cacheService: { get: jest.fn(), set: jest.fn() }
    });
    expect(aggregator.providers).toContain(mockRoxie);
  });
});
