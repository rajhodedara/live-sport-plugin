'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/services/ProviderOutbound');
const LeafProvider = require('../src/providers/LeafProvider');
const oldLeafConfig = process.env.LEAF_INSTALL_CONFIG;
const oldLeafUrl = process.env.LEAF_API_URL;
beforeEach(() => { process.env.LEAF_INSTALL_CONFIG = 'fixture-config'; delete process.env.LEAF_API_URL; });
afterEach(() => {
  if (oldLeafConfig === undefined) delete process.env.LEAF_INSTALL_CONFIG; else process.env.LEAF_INSTALL_CONFIG = oldLeafConfig;
  if (oldLeafUrl === undefined) delete process.env.LEAF_API_URL; else process.env.LEAF_API_URL = oldLeafUrl;
});


test('accepts Leaf hostnames and preserves the original signed URL while ignoring lookalikes', async () => {
  const valid = 'https://papacito.cfd/m3u/example/live.m3u8?ft=a%2Bb%3D';
  const subdomain = 'https://edge.papacito.cfd/m3u/example/live.m3u8?ft=fixture';
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
  expect(streams.map(stream => new URL(stream.url, 'https://addon.example').searchParams.get('url'))).toEqual([valid, subdomain]);
});
