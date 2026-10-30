// The unit fixture never executes provider WASM/network bootstrap.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

'use strict';

process.env.NODE_ENV = 'test';

const TimStreamsProvider = require('../src/providers/TimStreamsProvider');
const { isMatchLive } = require('../src/catalog');

function getNYString(offsetMs) {
  const target = new Date(Date.now() + offsetMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(target);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

describe('TimStreamsProvider Robust Date and Live Status Handling', () => {
  let provider;

  beforeEach(() => {
    provider = new TimStreamsProvider({
      circuitBreaker: {
        wrap: (name, fn) => ({ fire: fn }),
        wrapSync: (name, fn) => ({ fire: fn })
      }
    });
  });

  test('future event is classified as upcoming with popular=0 and is not live', async () => {
    const futureDate = getNYString(24 * 3600 * 1000); // Tomorrow in NY
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'liverpool-vs-villarreal-test',
            name: 'Liverpool vs Villarreal',
            genre: 'football',
            time: futureDate,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.id).toBe('ts_liverpool-vs-villarreal-test');
    expect(match.status).toBe('upcoming');
    expect(match.popular).toBe('0'); // Upcoming matches must never be popular=1
    expect(Number(match.date)).toBeGreaterThan(Date.now());
    expect(isMatchLive(match)).toBe(false); // Catalog must NOT treat it as live
  });

  test('live event within 4 hours is classified as live and respects featured for popularity', async () => {
    const liveDate = getNYString(-30 * 60 * 1000); // 30m ago in NY
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'live-derby',
            name: 'Live Derby Match',
            genre: 'football',
            time: liveDate,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.status).toBe('live');
    expect(match.popular).toBe('1');
    expect(isMatchLive(match)).toBe(true);
  });

  test('expired event older than 4 hours is dropped completely', async () => {
    const pastDate = getNYString(-6 * 3600 * 1000); // 6 hours ago in NY
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'old-match',
            name: 'Old Match Ended Hours Ago',
            genre: 'football',
            time: pastDate,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(0); // TimStreams must drop stale events
  });

  test('missing or unparseable time sets empty date and upcoming status without defaulting to Date.now()', async () => {
    provider.fetchData = {
      fire: async () => ({
        events: [
          {
            url: 'undated-fixture',
            name: 'Undated Fixture',
            genre: 'football',
            time: null,
            featured: true,
            streams: [{ name: 'Stream 1', url: 'https://embed.test/1' }]
          }
        ]
      })
    };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.date).toBe(''); // Must not be Date.now()
    expect(match.status).toBe('upcoming');
    expect(match.popular).toBe('0');
    expect(isMatchLive(match)).toBe(false); // Catalog must not treat undated upcoming fixture as live
  });
});

describe('TimStreamsProvider Decryption & Stream Resolution', () => {
  let provider;

  beforeEach(() => {
    provider = new TimStreamsProvider({
      circuitBreaker: {
        wrap: (name, fn) => ({ fire: fn }),
        wrapSync: (name, fn) => ({ fire: fn })
      }
    });
  });

  test('decodeObfuscatedScript decodes XOR script with 2-paren syntax', () => {
    const rawJs = 'function loadStreamUrl(){console.log("ok");}';
    const xor = 101;
    const sub = 208;
    const encArr = [];
    for (let i = 0; i < rawJs.length; i++) {
      encArr.push(((rawJs.charCodeAt(i) + sub) % 256) ^ xor);
    }
    const html = `<script>var _ca1=[${encArr.join(',')}],_wu0=101,_wa1=208,_jx7="",_gn5;for(_gn5=0;_gn5<_ca1.length;_gn5++){_jx7+=String.fromCharCode(((_ca1[_gn5]^_wu0)-_wa1+256)%256);}window["eval"](_jx7);</script>`;

    const decoded = provider.decodeObfuscatedScript(html);
    expect(decoded).toBe(rawJs);
  });

  test('decodeObfuscatedScript decodes XOR script with 3-paren syntax', () => {
    const rawJs = 'var streamUrl = "https://example.com/live.m3u8";';
    const xor = 77;
    const sub = 120;
    const encArr = [];
    for (let i = 0; i < rawJs.length; i++) {
      encArr.push(((rawJs.charCodeAt(i) + sub) % 256) ^ xor);
    }
    const html = `<script>var _data=[${encArr.join(',')}],_k1=77,_k2=120;for(var i=0;i<_data.length;i++){s+=String.fromCharCode((((_data[i]^_k1)-_k2+256)%256));}</script>`;

    const decoded = provider.decodeObfuscatedScript(html);
    expect(decoded).toBe(rawJs);
  });

  test('extractM3u8 decrypts 2-hop loadStreamUrl response', async () => {
    const embedUrl = 'https://ehgembxe.cfd/test-embed-123';
    const tokenUrl = 'https://tims-nl-0001.duckdns.org/p/token-xyz';
    const finalM3u8 = 'https://p16.tiktokcdn-us.com/live/master.m3u8';

    // 1. Mock embed HTML
    const rawScript = `loadStreamUrl("${tokenUrl}", function(url){ player.src(url); });`;
    const xor = 50;
    const sub = 30;
    const encArr = [];
    for (let i = 0; i < rawScript.length; i++) {
      encArr.push(((rawScript.charCodeAt(i) + sub) % 256) ^ xor);
    }
    const html = `<script>var _arr=[${encArr.join(',')}],_k1=50,_k2=30;for(var i=0;i<_arr.length;i++){res+=String.fromCharCode(((_arr[i]^_k1)-_k2+256)%256);}</script>`;

    // 2. Mock token payload
    const tk = 'token-xyz';
    const seed = 42;
    const tokenBuf = Buffer.alloc(1 + finalM3u8.length);
    tokenBuf[0] = seed;
    for (let i = 0; i < finalM3u8.length; i++) {
      tokenBuf[i + 1] = finalM3u8.charCodeAt(i) ^ tk.charCodeAt(i % tk.length) ^ ((seed + i) & 255);
    }

    provider.proxyFetch = jest.fn(async (url) => {
      if (url === embedUrl) {
        return {
          ok: true,
          text: async () => html
        };
      }
      if (url === tokenUrl) {
        return {
          ok: true,
          arrayBuffer: async () => tokenBuf.buffer.slice(tokenBuf.byteOffset, tokenBuf.byteOffset + tokenBuf.byteLength)
        };
      }
      return { ok: false };
    });

    const result = await provider.extractM3u8(embedUrl);
    expect(result).not.toBeNull();
    expect(result.m3u8).toBe(finalM3u8);
    expect(result.referer).toBe('https://ehgembxe.cfd');
  });

  test('resolveStream constructs HD StreamEntity with proxyHeaders and manifest proxy', async () => {
    const embedUrl = 'https://ehgembxe.cfd/game-stream';
    const finalM3u8 = 'https://p16.tiktokcdn-us.com/live/game.m3u8';

    provider.extractM3u8 = jest.fn().mockResolvedValue({
      m3u8: finalM3u8,
      referer: 'https://ehgembxe.cfd'
    });

    const hexSource = Buffer.from(embedUrl).toString('hex');
    const streams = await provider.resolveStream(hexSource, 'football', 'Test Final Match');

    expect(streams.length).toBeGreaterThanOrEqual(1);
    const mainStream = streams.find(s => s.name === 'TimStreams');
    expect(mainStream).toBeDefined();
    expect(mainStream.url).toContain('/api/manifest?url=');
    expect(mainStream.url).toContain(encodeURIComponent(finalM3u8));
    expect(mainStream.behaviorHints.proxyHeaders.request.Referer).toBe('https://ehgembxe.cfd');
    expect(mainStream.resolution).toBe('HD');
  });
});
