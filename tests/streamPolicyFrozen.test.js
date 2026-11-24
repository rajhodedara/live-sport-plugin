'use strict';

const { isFrozenMediaPlaylist } = require('../src/services/StreamPolicy');

describe('StreamPolicy — frozen media playlists', () => {
  test('flags a media playlist that never advanced past sequence 0', () => {
    const body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:11\n#EXT-X-MEDIA-SEQUENCE:0\n';
    expect(isFrozenMediaPlaylist(body)).toBe(true);
  });

  test('leaves a media playlist whose sequence has advanced alone', () => {
    expect(isFrozenMediaPlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n')).toBe(false);
  });

  test('does not match sequence 0 without an HLS header', () => {
    expect(isFrozenMediaPlaylist('#EXT-X-MEDIA-SEQUENCE:0\n')).toBe(false);
  });

  test('leaves master playlists alone', () => {
    const body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080\nchunklist.m3u8\n';
    expect(isFrozenMediaPlaylist(body)).toBe(false);
  });

  test('rejects bodies that are not playlists', () => {
    expect(isFrozenMediaPlaylist('not a playlist')).toBe(false);
  });
});
