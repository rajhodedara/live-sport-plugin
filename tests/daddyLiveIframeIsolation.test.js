'use strict';
const Provider = require('../src/providers/DaddyLiveProvider');
test('tries a second iframe when the first fails', async () => {
  const circuitBreaker = { wrap: () => ({ fire: async () => null }), wrapSync: () => ({ fire: async () => null }) };
  const p = new Provider({ circuitBreaker }); p.baseDomains = ['https://provider.example.invalid']; p.folders = ['stream'];
  p.proxyFetch = jest.fn(async url => {
    if (url.includes('/stream-')) return { ok: true, text: async () => '<iframe src="https://first.invalid/"></iframe><iframe src="https://second.invalid/"></iframe>' };
    if (url.includes('first.invalid')) throw new Error('fixture failure');
    return { ok: true, text: async () => '<html></html>' };
  });
  p._resolveFromHtml = jest.fn(async () => ({ url: 'https://cdn.example.invalid/live.m3u8' }));
  const streams = await p.resolveStream('123', 'football', 'Fixture');
  expect(p.proxyFetch.mock.calls.some(([url]) => url.includes('second.invalid'))).toBe(true);
  expect(streams.some(stream => stream.url && stream.url.includes('/api/manifest'))).toBe(true);
});
