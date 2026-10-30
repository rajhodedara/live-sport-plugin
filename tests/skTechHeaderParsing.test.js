'use strict';
const matches = require('../src/resolver/sktech/SkTechMatchResolver');
const channels = require('../src/resolver/sktech/SkTechChannelResolver');
const ref = 'https://embed.example.invalid/watch?token=a=b&x=2';
const playlist = `#EXTM3U\n#EXTINF:-1 group-title="football",Fixture 1080p\n#EXTVLCOPT:http-referrer=${ref}\nhttps://cdn.example.invalid/live.m3u8\n`;
test('event playlist keeps the full referrer value including equals signs', () => {
  const events = []; matches.parseM3UContent(playlist, { label: 'Fixture', url: 'https://fixture.invalid/' }, new Map(), events);
  expect(events[0].sources[0].streamHeaders.Referer).toBe(ref);
});
test('channel playlist keeps the full referrer value including equals signs', () => {
  expect(channels.parseM3uBouquet(playlist, 'Fixture')[0].headers.Referer).toBe(ref);
});

test('event playlist preserves an explicit user agent before applying defaults', () => {
  const text = '#EXTM3U\n#EXTINF:-1 group-title="football",Fixture 1080p\n#EXTVLCOPT:http-user-agent=FixtureClient/1.0\nhttps://cdn.example.invalid/live.m3u8\n';
  const events = []; matches.parseM3UContent(text, { label: 'Fixture', url: 'https://fixture.invalid/' }, new Map(), events);
  expect(events[0].sources[0].streamHeaders['User-Agent']).toBe('FixtureClient/1.0');
});
test('channel playlist preserves an explicit user agent before applying defaults', () => {
  const text = '#EXTM3U\n#EXTINF:-1,Fixture\n#EXTVLCOPT:http-user-agent=FixtureClient/1.0\nhttps://cdn.example.invalid/live.m3u8\n';
  expect(channels.parseM3uBouquet(text, 'Fixture')[0].headers['User-Agent']).toBe('FixtureClient/1.0');
});
test('inline headers override playlist headers and missing user agents keep a default', () => {
  const text = '#EXTM3U\n#EXTINF:-1,Fixture\n#EXTVLCOPT:http-user-agent=PlaylistUA\nhttps://cdn.example.invalid/live.m3u8|user-agent=InlineUA\n#EXTINF:-1,Other\nhttps://cdn.example.invalid/other.m3u8\n';
  const entries = channels.parseM3uBouquet(text, 'Fixture');
  expect(entries[0].headers['User-Agent']).toBe('InlineUA');
  expect(entries[1].headers['User-Agent']).toContain('Mozilla/5.0');
});
