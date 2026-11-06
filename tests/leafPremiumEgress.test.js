'use strict';

const { isLeafTarget, selectGuardedEgress } = require('../src/services/GuardedEgressPolicy');
const premiumHosts = ['to', 'dev'].flatMap(tld => ['premium', 'premium-us2', 'premium-eu1'].map(host => `${host}.highfly.${tld}`));
const TOKEN = '00000000-0000-4000-8000-000000000001';
const environments = [
  [{ LEAF_PROXY_URL: 'socks5://leaf.invalid:1', WARP_PROXY_URL: 'socks5://warp.invalid:2', DAMITV_PROXY_URL: 'socks5://dami.invalid:3' }, 'socks5://leaf.invalid:1'],
  [{ WARP_PROXY_URL: 'socks5://warp.invalid:2', DAMITV_PROXY_URL: 'socks5://dami.invalid:3' }, 'socks5://warp.invalid:2'],
  [{ DAMITV_PROXY_URL: 'socks5://dami.invalid:3' }, 'socks5://dami.invalid:3'],
  [{}, null],
];

test.each(premiumHosts)('premium API %s and papacito mint use the same proxy and Chrome profile', host => {
  const urls = [
    `https://${host}/${TOKEN}/catalog/sport/sports_live.json`,
    `https://${host}/${TOKEN}/pabc123/stream/sport/fixture.json`,
    'https://papacito.cfd/m3u/fixture/live.m3u8?ft=fixture',
  ];
  for (const [environment, proxyUrl] of environments) {
    for (const url of urls) {
      expect(isLeafTarget(url)).toBe(true);
      expect(selectGuardedEgress(url, {}, environment)).toEqual({ proxyUrl, profile: 'chrome' });
      expect(selectGuardedEgress(url, { proxyUrl: null }, environment)).toEqual({ proxyUrl: null, profile: 'chrome' });
      expect(selectGuardedEgress(url, { proxyUrl: 'socks5://explicit.invalid:4', profile: 'vanilla' }, environment))
        .toEqual({ proxyUrl: 'socks5://explicit.invalid:4', profile: 'vanilla' });
    }
  }
});

test.each([
  'https://premium.highfly.to.evil.invalid/stream',
  'https://premium.highfly.dev.evil.invalid/stream',
  'https://highfly.to.evil.invalid/stream',
  'https://premium.highfly.to@evil.invalid/stream',
  'https://fixture@premium.highfly.to/stream',
  'https://@premium.highfly.to/stream',
  'https://fixture:secret@premium-us2.highfly.to/stream',
  'https://elsewhere.invalid/stream?target=https://premium.highfly.to',
  'https://elsewhere.invalid/premium-eu1.highfly.to/stream',
  'https://w1.papacito.cfd/leaf/fixture/seg.ts?source=premium.highfly.to',
  'https://child.w1.papacito.cfd/leaf/fixture/seg.ts',
  'https://east.papacito.cfd/leaf/fixture/seg.ts?source=premium.highfly.dev',
  'https://child.east.papacito.cfd/leaf/fixture/seg.ts',
])('non-premium host or userinfo never selects the Leaf proxy: %s', url => {
  expect(isLeafTarget(url)).toBe(false);
  expect(selectGuardedEgress(url, {}, { LEAF_PROXY_URL: 'socks5://leaf.invalid:1' }))
    .toEqual({ proxyUrl: null, profile: 'chrome' });
});

test('retains free Leaf, gateway, direct CDN and DamiTV classification', () => {
  const environment = { LEAF_PROXY_URL: 'socks5://leaf.invalid:1', WARP_PROXY_URL: 'socks5://warp.invalid:2' };
  for (const url of ['https://sports.highfly.to/install/catalog.json', 'https://gateway.papacito.cfd/m3u/fixture/live.m3u8']) {
    expect(selectGuardedEgress(url, {}, environment)).toEqual({ proxyUrl: 'socks5://leaf.invalid:1', profile: 'chrome' });
  }
  expect(selectGuardedEgress('https://w1.papacito.cfd/leaf/fixture/seg.ts', {}, environment))
    .toEqual({ proxyUrl: null, profile: 'chrome' });
  expect(selectGuardedEgress('https://east.papacito.cfd/leaf/fixture/seg.ts', {}, environment))
    .toEqual({ proxyUrl: null, profile: 'chrome' });
  expect(selectGuardedEgress('https://messi.damitv.st/metadata', {}, environment))
    .toEqual({ proxyUrl: 'socks5://warp.invalid:2', profile: 'vanilla' });
});

test.each([
  'https://highfly.to/', 'https://highfly.dev/', 'https://api.highfly.dev/catalog',
  'https://premium-dedicated.highfly.to/stream', 'https://child.premium.highfly.dev/stream',
])('preserves current real-hostname Highfly family classification: %s', url => {
  expect(isLeafTarget(url)).toBe(true);
  expect(selectGuardedEgress(url, {}, { LEAF_PROXY_URL: 'socks5://leaf.invalid:1' }))
    .toEqual({ proxyUrl: 'socks5://leaf.invalid:1', profile: 'chrome' });
});
