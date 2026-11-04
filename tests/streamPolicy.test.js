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

  test('leaves the DASH manifest proxy alone — segments stay on the CDN', () => {
    const url = `${BASE}/api/manifest.mpd?url=${encodeURIComponent('https://cdn.example.com/live/cenc.mpd')}&token=abc`;
    expect(isRelayedDashStream({ url })).toBe(false);
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
});
