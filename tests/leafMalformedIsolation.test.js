'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const client = require('../src/services/ProviderOutbound');
const Provider = require('../src/providers/LeafProvider');
const oldLeafConfig = process.env.LEAF_INSTALL_CONFIG;
const oldLeafUrl = process.env.LEAF_API_URL;
beforeEach(() => { process.env.LEAF_INSTALL_CONFIG = 'fixture-config'; delete process.env.LEAF_API_URL; });
afterEach(() => {
  if (oldLeafConfig === undefined) delete process.env.LEAF_INSTALL_CONFIG; else process.env.LEAF_INSTALL_CONFIG = oldLeafConfig;
  if (oldLeafUrl === undefined) delete process.env.LEAF_API_URL; else process.env.LEAF_API_URL = oldLeafUrl;
});

afterEach(() => client.safeFetch.mockReset());
test('malformed event id does not discard valid events', async () => {
  client.safeFetch.mockResolvedValue({ ok: true, json: async () => ({ metas: [{ id: 'streamed:one', name: 'First' }, { id: 42, name: 'Malformed' }, { id: 'streamed:two', name: 'Second' }] }) });
  const matches = await new Provider().getMatches();
  expect(matches.map(m => m.title)).toEqual(['First', 'Second']);
});
test('malformed stream fields do not discard later valid streams', async () => {
  client.safeFetch.mockResolvedValue({ ok: true, json: async () => ({ streams: [{ url: 42 }, { url: 'https://papacito.cfd/m3u/event/live.m3u8?token=fixture', name: 42, title: {} }, { url: 'https://papacito.cfd/m3u/event2/live.m3u8?token=fixture', name: 'Next' }] }) });
  const streams = await new Provider().resolveStream('fixture'); expect(streams).toHaveLength(2);
});
