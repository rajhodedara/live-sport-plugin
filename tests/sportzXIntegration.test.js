'use strict';

const container = require('../src/container');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');

describe('SportzX Invariant I4 Registration', () => {
  it('registers sportzxProvider in Awilix container as a singleton', () => {
    const provider = container.resolve('sportzxProvider');
    expect(provider).toBeDefined();
    expect(provider.name).toBe('SportzX');

    const provider2 = container.resolve('sportzxProvider');
    expect(provider).toBe(provider2);
  });

  it('includes sportzxProvider in MatchAggregator providers list', () => {
    const aggregator = container.resolve('matchAggregator');
    expect(aggregator).toBeDefined();
    const hasSportzX = aggregator.providers.some(p => p && p.name === 'SportzX');
    expect(hasSportzX).toBe(true);
  });
});
