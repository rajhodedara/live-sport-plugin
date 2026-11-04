// These parser/extractor unit tests do not exercise or launch WASM workers.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in provider unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

jest.mock('../src/services/ProviderOutbound', () => ({
  fetchUndici: (...args) => {
    if (!jest.isMockFunction(global.fetch)) throw new Error('Unexpected SK Tech I/O in unit fixture');
    return global.fetch(...args);
  }
}));

'use strict';

const crypto = require('crypto');
// Module exports a singleton instance, not the class
const resolver = require('../src/resolver/sktech/SkTechMatchResolver');
const SkTechCrypto = require('../src/resolver/sktech/SkTechCrypto');

/**
 * Inverts SkTechCrypto.decryptPrimary so tests can serve encrypted pro feeds:
 * JSON → AES-128-CBC → base64 → reverse → base64 → alphabet substitution.
 */
function encryptPrimary(obj) {
  const cipher = crypto.createCipheriv('aes-128-cbc', SkTechCrypto.primaryKey, SkTechCrypto.primaryIv);
  cipher.setAutoPadding(true);
  const inner = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]).toString('base64');
  const reversedB64 = Buffer.from(inner.split('').reverse().join(''), 'utf8').toString('base64');

  const inverse = new Map();
  for (const [cipherChar, plainChar] of SkTechCrypto.dMap.entries()) {
    inverse.set(plainChar, cipherChar);
  }
  let out = '';
  for (const ch of reversedB64) out += inverse.get(ch) || ch;
  return out.replace(/=+$/, '');
}

const MPD_URL = 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd';
const KEY_HEX = 'ca0b64b84edb4f20eb1e135ff03db4f7';
const KID_HEX = '18e6af4a0daf2a1fdfbdc5b541520c88';

describe('SK Tech ClearKey DASH — dropped by bandwidth policy', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function mockFeed(options) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => encryptPrimary(options)
    });
  }

  test('drops .mpd + kid:key entries instead of relaying them through /api/dash', async () => {
    mockFeed([
      { name: 'Server 1', link: MPD_URL, api: `${KID_HEX}:${KEY_HEX}` },
      { name: 'HLS Server', link: 'https://cdn.example.com/live/index.m3u8' }
    ]);

    const streams = await resolver.resolveMatchStreams('pro/testmatch.txt', 'Japan vs Venezuela');
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe('https://cdn.example.com/live/index.m3u8');
    expect(streams.some((s) => s.url.includes('/api/dash/'))).toBe(false);
    expect(streams.some((s) => s.url.includes('.mpd'))).toBe(false);
  });

  test('drops piped ClearKey DASH entries regardless of upstream headers', async () => {
    mockFeed([
      {
        name: 'Bein Feed',
        link: `${MPD_URL}|User-Agent=Dalvik/2.1.0 (Linux; U; Android 13; Pixel 5)&Referer=https://upstream.example/`,
        api: `${KID_HEX}:${KEY_HEX}`
      }
    ]);

    const streams = await resolver.resolveMatchStreams('pro/headers.txt', 'Match');
    expect(streams).toEqual([]);
  });

  test('drops .mpd entries without a usable ClearKey (no api or malformed key)', async () => {
    mockFeed([
      { name: 'No Key', link: MPD_URL },
      { name: 'Bad Key', link: MPD_URL, api: 'notahexkey:shortkey' },
      { name: 'Valid HLS', link: 'https://cdn.example.com/live/index.m3u8' }
    ]);

    const streams = await resolver.resolveMatchStreams('pro/mixed.txt', 'Match');
    expect(streams.length).toBe(1);
    expect(streams[0].url).toBe('https://cdn.example.com/live/index.m3u8');
  });

  test('decryption failure yields an empty list (no raw .mpd leakage)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => 'not-valid-ciphertext'
    });
    const streams = await resolver.resolveMatchStreams('pro/broken.txt', 'Match');
    expect(streams).toEqual([]);
  });
});
