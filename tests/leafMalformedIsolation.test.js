'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const client = require('../src/services/ProviderOutbound');
const Provider = require('../src/providers/LeafProvider');
const leafMint = require('../src/services/LeafMint');
const { resetAccountRateLimits } = require('../src/services/LeafRateLimitState');
const oldAppSecret = process.env.APP_SECRET;
const oldLeafEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LEAF_')));
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('LEAF_')) delete process.env[key];
  resetAccountRateLimits();
  leafMint.invalidate();
  process.env.APP_SECRET = 'pr61-leaf-fixture-private-key';
  process.env.LEAF_INSTALL_CONFIG = 'fixture-config';
});
afterEach(() => {
  if (oldAppSecret === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = oldAppSecret;
  for (const key of Object.keys(process.env)) if (key.startsWith('LEAF_')) delete process.env[key];
  Object.assign(process.env, oldLeafEnv);
});

afterEach(() => client.safeFetch.mockReset());
test('malformed event id does not discard valid events', async () => {
  client.safeFetch.mockResolvedValue({ ok: true, status: 200, bodyTruncated: false, json: async () => ({ metas: [{ id: 'streamed:one', name: 'First' }, { id: 42, name: 'Malformed' }, { id: 'streamed:two', name: 'Second' }] }) });
  const matches = await new Provider().getMatches();
  expect(matches.map(m => m.title)).toEqual(['First', 'Second']);
});
test('malformed stream fields do not discard later valid streams', async () => {
  client.safeFetch.mockImplementation(async url => url.includes('/stream/sport/')
    ? { ok: true, status: 200, json: async () => ({ streams: [{ url: 42 }, { url: 'https://papacito.cfd/m3u/event/live.m3u8?token=fixture', name: 42, title: {} }, { url: 'https://papacito.cfd/m3u/event2/live.m3u8?token=fixture', name: 'Next' }] }) }
    : { ok: true, status: 200, bodyTruncated: false, text: async () => '#EXTM3U\n#EXTINF:6,\nhttps://w1.papacito.cfd/leaf/fixture/1/seg_1.ts\n' });
  const streams = await new Provider().resolveStream('fixture'); expect(streams).toHaveLength(2);
});
