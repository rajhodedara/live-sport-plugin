'use strict';
const Provider = require('../src/providers/Ak47LiveProvider');
const p = new Provider();
const ref = 'https://embed.example.invalid/watch?token=a=b';
const opt = `#EXTVLCOPT:http-referrer=${ref}`;
test.each([true, false])('preserves headers before or after EXTINF (before=%s)', before => {
  const lines = before ? [opt, '#EXTINF:-1,Event'] : ['#EXTINF:-1,Event', opt];
  const entries = p._parseM3u(['#EXTM3U', ...lines, 'https://cdn.example.invalid/live.m3u8'].join('\n'));
  expect(entries).toHaveLength(1); expect(entries[0].referer).toBe(ref);
});
test('an event with no URL does not consume the next entry or carry its headers', () => {
  const entries = p._parseM3u(['#EXTINF:-1,Missing', opt, '#EXTINF:-1,Next', 'https://cdn.example.invalid/live.m3u8'].join('\n'));
  expect(entries).toHaveLength(1); expect(entries[0].rawTitle).toBe('Next'); expect(entries[0].referer).not.toBe(ref);
});
