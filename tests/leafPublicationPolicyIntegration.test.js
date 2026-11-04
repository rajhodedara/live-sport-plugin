'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/services/ProviderOutbound');
const LeafProvider = require('../src/providers/LeafProvider');
const leafState = require('../src/services/LeafState');
const originalEnv = { ...process.env };
beforeEach(() => {
  process.env.LEAF_INSTALL_CONFIG = 'fixture-install';
  process.env.APP_SECRET = 'fixture-private-leaf-state-key';
  delete process.env.LEAF_API_URL;
  safeFetch.mockReset();
});
afterEach(() => { process.env = { ...originalEnv }; });

test.each([
  'http://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture',
  'https://papacito.cfd:8443/m3u/fixture/live.m3u8?ft=fixture',
  'https://user:secret@papacito.cfd/m3u/fixture/live.m3u8?ft=fixture',
  'https://papacito.cfd.example/m3u/fixture/live.m3u8?ft=fixture',
  ' https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture',
  'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture\n',
  'https://papacito.cfd/m3u/fixture/live.m3u8',
  'https://papacito.cfd/m3u/fixture/live.m3u8#fragment?ft=fixture'
])('unsupported target does not publish a broken tile or discard an adjacent valid source: %s', async url => {
  const valid = 'https://papacito.cfd/m3u/valid/live.m3u8?ft=fixture%2Fone&x=two%2Bthree';
  safeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ streams: [
    { name: 'Unsupported', url }, { name: 'Valid', url: valid }
  ] }) });
  const streams = await new LeafProvider().resolveStream('fixture-id');
  expect(streams).toHaveLength(1);
  const published = new URL(streams[0].url);
  expect(published.pathname).toMatch(/^\/api\/leaf\/m3u8\/[^/]+\/index\.m3u8$/);
  const token = published.pathname.split('/')[4];
  expect(leafState.verify(token)).toMatchObject({ m: 'fixture-id', s: 'valid' });
  expect(streams[0].url).not.toContain('ft=');
  expect(streams[0].url).not.toContain(encodeURIComponent(valid));
});

test('a permitted subdomain publishes application state without forwarding its upstream credential', async () => {
  const valid = 'https://gateway.papacito.cfd/m3u/fixture/live.m3u8?ft=one%2Ftwo&x=three%2Bfour';
  safeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ streams: [{ name: 'Valid', url: valid }] }) });
  const streams = await new LeafProvider().resolveStream('fixture-id');
  expect(streams).toHaveLength(1);
  const token = new URL(streams[0].url).pathname.split('/')[4];
  expect(leafState.verify(token)).toMatchObject({ m: 'fixture-id', s: 'fixture' });
  expect(streams[0].url).not.toContain('one%2Ftwo');
  expect(streams[0].url).not.toContain(encodeURIComponent(valid));
});
