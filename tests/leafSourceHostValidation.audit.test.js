'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/services/ProviderOutbound');
const LeafProvider = require('../src/providers/LeafProvider');
const oldAppSecret = process.env.APP_SECRET;
const oldLeafStateSecret = process.env.LEAF_STATE_SECRET;
const oldLeafConfig = process.env.LEAF_INSTALL_CONFIG;
const oldLeafUrl = process.env.LEAF_API_URL;
beforeEach(() => { process.env.APP_SECRET = 'pr61-leaf-fixture-private-key'; delete process.env.LEAF_STATE_SECRET; process.env.LEAF_INSTALL_CONFIG = 'fixture-config'; delete process.env.LEAF_API_URL; });
afterEach(() => {
  if (oldAppSecret === undefined) delete process.env.APP_SECRET; else process.env.APP_SECRET = oldAppSecret;
  if (oldLeafStateSecret === undefined) delete process.env.LEAF_STATE_SECRET; else process.env.LEAF_STATE_SECRET = oldLeafStateSecret;
  if (oldLeafConfig === undefined) delete process.env.LEAF_INSTALL_CONFIG; else process.env.LEAF_INSTALL_CONFIG = oldLeafConfig;
  if (oldLeafUrl === undefined) delete process.env.LEAF_API_URL; else process.env.LEAF_API_URL = oldLeafUrl;
});


test('accepts Leaf hostnames into signed application state while ignoring lookalikes', async () => {
  const valid = 'https://papacito.cfd/m3u/example/live.m3u8?ft=a%2Bb%3D';
  const subdomain = 'https://edge.papacito.cfd/m3u/sub-example/live.m3u8?ft=fixture';
  const entries = [
    valid, subdomain,
    'https://other.example/path/papacito.cfd?ft=fixture',
    'https://papacito.cfd.other.example/live.m3u8?ft=fixture',
    'https://papacito.cfd@other.example/live.m3u8?ft=fixture',
    'https://user@papacito.cfd/live.m3u8?ft=fixture',
    'ftp://papacito.cfd/live.m3u8?ft=fixture',
  ];
  safeFetch.mockResolvedValue({ ok: true, json: async () => ({ streams: entries.map(url => ({ url })) }) });
  const streams = await new LeafProvider().resolveStream('fixture');
  expect(streams).toHaveLength(2);
  const leafState = require('../src/services/LeafState');
  for (const [index, stream] of streams.entries()) {
    const published = new URL(stream.url, 'https://addon.example');
    const match = published.pathname.match(/^\/api\/leaf\/m3u8\/([^/]+)\/index\.m3u8$/);
    expect(match).not.toBeNull();
    expect(leafState.verify(match[1])).toMatchObject({ m: 'fixture', s: ['example', 'sub-example'][index] });
    expect(published.search).toBe('');
    expect(stream.url).not.toContain('ft=');
    expect(stream.url).not.toContain('papacito.cfd');
  }
});
