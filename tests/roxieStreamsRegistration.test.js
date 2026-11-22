const container = require('../src/container');
const RoxieStreamsProvider = require('../src/providers/RoxieStreamsProvider');

describe('RoxieStreams Container Registration', () => {
  test('resolves roxiestreamsProvider singleton from container', () => {
    const provider = container.resolve('roxiestreamsProvider');
    expect(provider).toBeInstanceOf(RoxieStreamsProvider);
    expect(provider.sourceName).toBe('roxiestreams');
    expect(provider.name).toBe('RoxieStreams');
  });
});
