'use strict';

process.env.NODE_ENV = 'test';

const container = require('../src/container');

describe('SportsBite Registration Invariants (I4)', () => {
  test('sportsBiteProvider is registered in Awilix container cradle', () => {
    expect(container.cradle.sportsBiteProvider).toBeDefined();
    expect(container.cradle.sportsBiteProvider.name).toBe('SportsBite');
  });

  test('MatchAggregator includes sportsBiteProvider in provider list', () => {
    const aggregator = container.cradle.matchAggregator;
    expect(aggregator).toBeDefined();
    const names = aggregator.providers.map(p => p && p.name);
    expect(names).toContain('SportsBite');
  });
});
