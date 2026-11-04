// These parser/extractor unit tests do not exercise or launch WASM workers.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in provider unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({
  request: jest.fn(() => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  safeFetch: jest.fn(() => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  fetch: jest.fn(() => { throw new Error('Unexpected provider I/O in unit fixture'); })
}));


const crypto = require('crypto');
const ReplayZoneProvider = require('../src/providers/ReplayZoneProvider');

describe('ReplayZoneProvider - Byse Support', () => {
  let provider;

  beforeEach(() => {
    provider = new ReplayZoneProvider();
  });

  test('identifies Byse URLs correctly', () => {
    expect(provider._isByseUrl('https://bysefujedu.com/d/v4kc5zppy3vy')).toBe(true);
    expect(provider._isByseUrl('https://bysesukior.com/e/7zkihbvbnidj')).toBe(true);
    expect(provider._isByseUrl('https://bysecloud.net/e/123')).toBe(true);
    expect(provider._isByseUrl('https://ok.ru/videoembed/123')).toBe(false);
    expect(provider._isByseUrl('https://soccerfull.net/play/15734')).toBe(false);
  });

  test('decrypts Byse AES-256-GCM playback payload correctly', () => {
    // Construct test payload using version 7 (idx1 = 6, idx2 = 23)
    const partA = crypto.randomBytes(16);
    const partB = crypto.randomBytes(16);
    const fullKey = Buffer.concat([partA, partB]);
    const iv = crypto.randomBytes(12);

    const testData = {
      sources: [
        {
          label: '1080p',
          url: 'https://cdn.example.com/hls/master.m3u8',
          height: 1080
        }
      ],
      expires_at: new Date(Date.now() + 3600000).toISOString()
    };

    const cipher = crypto.createCipheriv('aes-256-gcm', fullKey, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(testData), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Buffer.concat([ciphertext, authTag]);

    // Build key parts array with length >= 24
    const key_parts = [];
    for (let i = 0; i < 30; i++) {
      if (i === 6) {
        key_parts.push(partA.toString('base64'));
      } else if (i === 23) {
        key_parts.push(partB.toString('base64'));
      } else {
        key_parts.push(crypto.randomBytes(16).toString('base64'));
      }
    }

    const playback = {
      algorithm: 'AES-256-GCM',
      version: '7',
      iv: iv.toString('base64'),
      payload: payload.toString('base64'),
      key_parts
    };

    const decrypted = provider._decryptBysePlayback(playback);
    expect(decrypted).not.toBeNull();
    expect(decrypted.sources).toHaveLength(1);
    expect(decrypted.sources[0].label).toBe('1080p');
    expect(decrypted.sources[0].url).toBe('https://cdn.example.com/hls/master.m3u8');
  });

  test('formats Byse streams with zero-bandwidth direct headers', () => {
    const sources = [
      {
        label: '1080p',
        url: 'https://cdn.example.com/master.m3u8',
        height: 1080
      }
    ];
    const streams = provider._formatByseStreams(sources, 'bysefujedu.com', 'Part 1');
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('ReplayZone');
    expect(streams[0].title).toBe('Part 1 (1080p) [SprintCDN]');
    expect(streams[0].resolution).toBe('1080p');
    expect(streams[0].url).toBe('https://cdn.example.com/master.m3u8');
    expect(streams[0].behaviorHints.notWebReady).toBe(false);
    expect(streams[0].behaviorHints.proxyHeaders.request.Origin).toBe('https://bysefujedu.com');
    expect(streams[0].behaviorHints.proxyHeaders.request.Referer).toBe('https://bysefujedu.com/');
  });
});
