'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/impitClient');
const LeafProvider = require('../src/providers/LeafProvider');

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
  expect(streams.map(stream => stream.url)).toEqual([valid, subdomain]);
});
