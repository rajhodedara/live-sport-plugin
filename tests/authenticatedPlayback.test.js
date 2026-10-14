'use strict';

const { rewriteHlsUri } = require('../src/services/HlsRewriteService');
const {
  appendPlaybackGrant, isOwnedPlaybackUrl, sanitizeAddonConfig
} = require('../src/auth/addonAuth');

describe('authenticated addon configuration', () => {
  test('removes authentication internals before business handlers cache config', () => {
    expect(sanitizeAddonConfig({
      teams: 'Arsenal',
      accessToken: 'nuvio_device_secret',
      __playbackGrant: 'grant',
    })).toEqual({ teams: 'Arsenal' });
  });

  test('adds grants only to owned playback routes', () => {
    expect(appendPlaybackGrant('/api/manifest?url=x', 'signed.grant')).toContain('pt=signed.grant');
    expect(appendPlaybackGrant('/watch?url=x', 'signed.grant')).toContain('pt=signed.grant');
    expect(appendPlaybackGrant(
      'https://nuvio.example/api/manifest?url=x',
      'signed.grant',
      'https://nuvio.example'
    )).toContain('pt=signed.grant');
    expect(appendPlaybackGrant(
      'https://attacker.example/api/manifest?url=x',
      'signed.grant',
      'https://nuvio.example'
    )).toBe('https://attacker.example/api/manifest?url=x');
    expect(appendPlaybackGrant('https://cdn.example/live.m3u8', 'signed.grant'))
      .toBe('https://cdn.example/live.m3u8');
  });

  test('recognizes an absolute local manifest proxy without double-wrapping its m3u8 query', () => {
    const localProxy = 'http://192.168.1.117:7001/api/manifest?url=https%3A%2F%2Fcdn.example%2Flive.m3u8';
    expect(isOwnedPlaybackUrl(localProxy, 'http://192.168.1.117:7001')).toBe(true);
    expect(isOwnedPlaybackUrl(localProxy, 'https://public.example')).toBe(false);
    const granted = appendPlaybackGrant(localProxy, 'signed.grant', 'http://192.168.1.117:7001');
    expect(granted).toContain('url=https%3A%2F%2Fcdn.example%2Flive.m3u8');
    expect(granted).toContain('pt=signed.grant');
  });

  test('expands compact collection configuration aliases before sanitizing secrets', () => {
    expect(sanitizeAddonConfig({ a: 'secret', z: 'UTC', sp: 'football' }))
      .toEqual({ timezone: 'UTC', sports: 'football' });
  });
});

describe('authenticated HLS rewriting', () => {
  test('propagates the playback grant through nested playlists', () => {
    const result = rewriteHlsUri('variant.m3u8', 'https://cdn.example/master.m3u8', {
      referer: 'https://embed.example/',
      playbackSuffix: '&pt=signed.grant',
    });
    expect(result).toContain('/api/manifest?');
    expect(result).toContain('pt=signed.grant');
  });

  test('routes segments and keys through the protected local proxy', () => {
    for (const uri of ['segment.ts', 'encryption.key', 'init.mp4']) {
      const result = rewriteHlsUri(uri, 'https://cdn.example/live/index.m3u8', {
        playbackSuffix: '&pt=signed.grant',
      });
      expect(result).toContain('/api/hlschunk?');
      expect(result).toContain('pt=signed.grant');
    }
  });

  test('preserves anonymous direct segment behavior without a grant', () => {
    expect(rewriteHlsUri('segment.ts', 'https://cdn.example/live/index.m3u8'))
      .toBe('https://cdn.example/live/segment.ts');
  });
});
