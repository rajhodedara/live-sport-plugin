'use strict';

const {
  isRelayedDashStream,
  isDashStream,
  isBlockedDashStream
} = require('../src/services/StreamPolicy');

const BASE = 'http://192.168.1.10:7000';

describe('StreamPolicy — bandwidth rules for DASH', () => {
  test('flags the /api/dash media relay regardless of query string', () => {
    expect(isRelayedDashStream({ url: `${BASE}/api/dash/index.m3u8?d=abc.def` })).toBe(true);
    expect(isRelayedDashStream({ url: `${BASE}/api/dash/video.m3u8?d=x&r=6` })).toBe(true);
    expect(isRelayedDashStream({ url: `${BASE}/api/dash/segment.mp4?d=x&n=42` })).toBe(true);
    expect(isBlockedDashStream({ url: `${BASE}/api/dash/index.m3u8?d=x` })).toBe(true);
  });

  test('leaves proxied live HLS alone (manifest proxy is not a media relay)', () => {
    const url = `${BASE}/api/manifest?url=${encodeURIComponent('https://cdn.example.com/live/index.m3u8')}&referer=https://example.com/`;
    expect(isRelayedDashStream({ url })).toBe(false);
    expect(isDashStream({ url })).toBe(false);
    expect(isBlockedDashStream({ url })).toBe(false);
  });

  test('blocks the DASH manifest proxy without classifying it as a media relay', () => {
    const url = `${BASE}/api/manifest.mpd?url=${encodeURIComponent('https://cdn.example.com/live/cenc.mpd')}&token=abc`;
    expect(isRelayedDashStream({ url })).toBe(false);
    expect(isDashStream({ url })).toBe(true);
    expect(isBlockedDashStream({ url })).toBe(true);
  });

  test('still blocks raw DASH, ClearKey and tagged replicas', () => {
    expect(isDashStream({ url: 'https://cdn.example.com/live/cenc.mpd?token=1' })).toBe(true);
    expect(isDashStream({ url: 'https://cdn.example.com/live/index.m3u8', clearkey: { key: 'x' } })).toBe(true);
    expect(isDashStream({ url: 'https://cdn.example.com/live/index.m3u8', format: 'dash' })).toBe(true);
    expect(isDashStream({ url: 'https://cdn.example.com/live/index.m3u8', type: 'application/dash+xml' })).toBe(true);
  });

  test('keeps plain HLS and R2 direct URLs', () => {
    expect(isBlockedDashStream({ url: 'https://cdn.example.com/live/index.m3u8' })).toBe(false);
    expect(isBlockedDashStream({ url: 'https://pub-123.r2.dev/stream.mp4' })).toBe(false);
  });

  test('tolerates malformed input', () => {
    expect(isBlockedDashStream(null)).toBe(false);
    expect(isBlockedDashStream({})).toBe(false);
    expect(isBlockedDashStream({ url: '' })).toBe(false);
  });

  test.each([
    '/api/manifest', '/api/manifest.m3u8', '/api/manifest.mpd',
    '/addon/api/manifest', '/addon/api/manifest.m3u8'
  ])('recognizes encoded MPD targets through %s without treating the proxy as a relay', endpoint => {
    const target = 'https://cdn.example.com/live/channel.MPD?token=one%2Ftwo&x=three%2Bfour#play';
    const stream = { url: `${BASE}${endpoint}?url=${encodeURIComponent(target)}` };
    expect(isRelayedDashStream(stream)).toBe(false);
    expect(isDashStream(stream)).toBe(true);
    expect(isBlockedDashStream(stream)).toBe(true);
  });

  test('unwraps nested relative and absolute manifest targets', () => {
    const target = 'https://cdn.example.com/live/channel.mpd?token=fixture';
    const child = `/api/manifest.m3u8?url=${encodeURIComponent(target)}`;
    const stream = { url: `${BASE}/addon/api/manifest?url=${encodeURIComponent(child)}` };
    expect(isBlockedDashStream(stream)).toBe(true);
    const absoluteChild = `${BASE}/api/manifest?url=${encodeURIComponent(target)}`;
    expect(isBlockedDashStream({ url: `/api/manifest.m3u8?url=${encodeURIComponent(absoluteChild)}` })).toBe(true);
  });

  test('keeps nested proxied HLS even when signed data mentions DASH-looking text', () => {
    const target = 'https://cdn.example.com/live/channel.m3u8?note=/api/dash/test&other=source.mpd#dash.mpd';
    const child = `/api/manifest?url=${encodeURIComponent(target)}`;
    const stream = { url: `${BASE}/api/manifest.m3u8?url=${encodeURIComponent(child)}` };
    expect(isRelayedDashStream(stream)).toBe(false);
    expect(isDashStream(stream)).toBe(false);
    expect(isBlockedDashStream(stream)).toBe(false);
  });

  test('rejects the actual relayed DASH endpoint hidden in a manifest target', () => {
    const target = `${BASE}/api/dash/index.m3u8?d=fixture`;
    const stream = { url: `/api/manifest?url=${encodeURIComponent(target)}` };
    expect(isRelayedDashStream(stream)).toBe(true);
    expect(isBlockedDashStream(stream)).toBe(true);
  });

  test.each([
    'https://cdn.example.com/live/channel.m3u8?note=/api/dash/test',
    'https://cdn.example.com/live/channel.m3u8?next=https://elsewhere.example/source.mpd',
    'https://cdn.example.com/live/channel.m3u8#source.mpd',
    'https://cdn.example.com/live/channel.mpd.backup',
    'https://cdn.example.com/api/dashboards/live.m3u8',
    'https://cdn.example.com/api/manifestation?url=https://elsewhere.example/source.mpd',
    'https://cdn.example.com/api/manifest.json?url=https://elsewhere.example/source.mpd'
  ])('keeps non-DASH resources with query/fragment/path lookalikes: %s', url => {
    expect(isBlockedDashStream({ url })).toBe(false);
  });

  test('does not mutate the stream or its original nested signed URL', () => {
    const url = `${BASE}/api/manifest.m3u8?url=${encodeURIComponent('https://cdn.example.com/live/channel.mpd?token=one%2Ftwo&x=three%2Bfour')}`;
    const stream = Object.freeze({ url, name: 'Fixture' });
    expect(isBlockedDashStream(stream)).toBe(true);
    expect(stream.url).toBe(url);
  });

  test('applies the same target policy to supported URL field fallbacks', () => {
    expect(isBlockedDashStream({ streamUrl: '/api/manifest?url=https%3A%2F%2Fcdn.example.com%2Fchannel.mpd%3Ftoken%3Dfixture' })).toBe(true);
    expect(isBlockedDashStream({ _rawMpdUrl: 'https://cdn.example.com/channel.mpd?token=fixture' })).toBe(true);
    expect(isRelayedDashStream({ url: '/addon/api/dash/video.m3u8?d=fixture' })).toBe(true);
  });
});
