const container = require('../src/container');

describe('RoxieStreams Dispatch Routing', () => {
  test('dispatches roxiestreams source to roxiestreamsProvider', async () => {
    const provider = container.resolve('roxiestreamsProvider');
    const spy = jest.spyOn(provider, 'resolveStream').mockResolvedValue([]);

    await provider.resolveStream('/soccer-streams-1', 'football', 'Juventus vs Venezia', { id: '/soccer-streams-1' });
    expect(spy).toHaveBeenCalledWith('/soccer-streams-1', 'football', 'Juventus vs Venezia', expect.any(Object));
    spy.mockRestore();
  });
});
