'use strict';
const Provider = require('../src/providers/VavooProvider');
const before = process.env.VAVOO_ENABLED;
beforeEach(() => { process.env.VAVOO_ENABLED = 'true'; });
afterAll(() => { if (before === undefined) delete process.env.VAVOO_ENABLED; else process.env.VAVOO_ENABLED = before; });
function setup() {
  const p = new Provider({ tokenManager: { getOrRefreshSig: jest.fn(async () => 'fixture') } });
  p.proxyFetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [{ url: 'https://cdn.example.invalid/live.m3u8' }] }));
  return p;
}
test.each(['https://unrelated.invalid/path?x=vavoo.to', 'https://vavoo.to.unrelated.invalid/play/1', 'https://vavoo.to@unrelated.invalid/play/1', 'ftp://vavoo.to/play/1'])('rejects non-mirror input %s before network', async url => {
  const p = setup(); expect(await p.resolveStream(url, 'networks', 'Fixture')).toEqual([]);
  expect(p.tokenManager.getOrRefreshSig).not.toHaveBeenCalled(); expect(p.proxyFetch).not.toHaveBeenCalled();
});
test.each(['https://vavoo.to/vavoo-iptv/play/123', 'https://sub.vavoo.to/vavoo-iptv/play/123', 'https://kool.ws/vavoo-iptv/play/123'])('continues accepting configured mirror %s', async url => {
  const p = setup(); const streams = await p.resolveStream(url, 'networks', 'Fixture'); expect(streams).toHaveLength(1); expect(p.proxyFetch).toHaveBeenCalledTimes(1);
});
