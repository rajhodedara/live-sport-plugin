'use strict';

const { lacksPlaylistEvidence } = require('../src/services/PlaylistEvidence');

describe('lacksPlaylistEvidence', () => {
  test('a complete body without #EXT is not a playlist', () => {
    expect(lacksPlaylistEvidence({ bodySample: 'Not found', bodyTruncated: false })).toBe(true);
  });

  test('a body containing #EXT is accepted whether or not it was truncated', () => {
    expect(lacksPlaylistEvidence({ bodySample: '#EXTM3U\n#EXT-X-VERSION:3', bodyTruncated: false })).toBe(false);
    expect(lacksPlaylistEvidence({ bodySample: '#EXTM3U\n#EXT-X-VERSION:3', bodyTruncated: true })).toBe(false);
  });

  test('truncated direct media (MPEG-TS, FLV) is kept: it can never contain #EXT', () => {
    expect(lacksPlaylistEvidence({ bodySample: 'G@\u0011\u0010\u0000\u0002', bodyTruncated: true })).toBe(false);
    expect(lacksPlaylistEvidence({ bodySample: 'FLV\u0001\u0005\u0000\u0000\u0000\t', bodyTruncated: true })).toBe(false);
  });

  test('a truncated HTML document is a soft-404, not media', () => {
    expect(lacksPlaylistEvidence({ bodySample: '<!DOCTYPE html><html><head>', bodyTruncated: true })).toBe(true);
    expect(lacksPlaylistEvidence({ bodySample: '\n  <html lang="en">', bodyTruncated: true })).toBe(true);
    expect(lacksPlaylistEvidence({ bodySample: '<BODY>', bodyTruncated: true })).toBe(true);
  });

  test('MPD and MP4 are decided elsewhere and never rejected here', () => {
    expect(lacksPlaylistEvidence({ isMpd: true, bodySample: '', bodyTruncated: false })).toBe(false);
    expect(lacksPlaylistEvidence({ isMp4: true, bodySample: '', bodyTruncated: true })).toBe(false);
  });
});
