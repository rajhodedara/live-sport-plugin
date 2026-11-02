'use strict';

const { isLeafTarget } = require('../src/impitClient');

describe('Leaf Selective Proxy Routing', () => {
  test('isLeafTarget correctly identifies Leaf auth and gateway domains only', () => {
    // True cases: sports.highfly.to and papacito.cfd auth gateway
    expect(isLeafTarget('https://sports.highfly.to/catalog/sport/sports_live.json')).toBe(true);
    expect(isLeafTarget('https://sports.highfly.to/eyJmcmVl.../stream/sport/123.json')).toBe(true);
    expect(isLeafTarget('https://papacito.cfd/m3u/ca-t34343443/live.m3u8?ft=token123')).toBe(true);
    expect(isLeafTarget('https://papacito.cfd/m3u/now-34334/live.m3u8')).toBe(true);

    // False cases: w1.papacito.cfd CDN media chunks must NEVER be proxied (Zero Server Bandwidth Bleed)
    expect(isLeafTarget('https://w1.papacito.cfd/leaf/ca-t34343443/1793426034/seg_14201.ts')).toBe(false);
    expect(isLeafTarget('https://w1.papacito.cfd/leaf/stream_notice/1793376749/seg_005.ts')).toBe(false);

    // False cases: other providers must never be matched
    expect(isLeafTarget('https://damitv.st/papi/api/streams')).toBe(false);
    expect(isLeafTarget('https://dembed.st/live/channel')).toBe(false);
    expect(isLeafTarget('https://streamed.pk/api/matches/live')).toBe(false);
    expect(isLeafTarget('https://dlive.sx/stream/1.html')).toBe(false);
    expect(isLeafTarget('')).toBe(false);
    expect(isLeafTarget(null)).toBe(false);
    expect(isLeafTarget(undefined)).toBe(false);
  });
});
