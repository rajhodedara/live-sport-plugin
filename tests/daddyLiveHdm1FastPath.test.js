'use strict';

jest.mock('../src/services/DaddyLiveMediaCheck', () => ({
  checkDaddyLiveMedia: jest.fn(async () => ({ status: 'ok' }))
}));

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(async () => { throw new Error('Unexpected outbound request in HDM1 fast-path fixture'); })
}));

const fs = require('fs');
const path = require('path');
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');

const BASE = 'https://daddy.fixture.invalid';
const FOLDER_EMBED = 'https://folder-embed.fixture.invalid/live';
const FOLDER_MANIFEST = 'https://folder-cdn.fixture.invalid/live.m3u8?token=folder';
const HDM1_MANIFEST = 'https://hdm1-cdn.fixture.invalid/TSN1/index.m3u8?token=hdm1';

function fixture({ slugs = { '111': 'TSN1' }, slugAlive = true } = {}) {
  const provider = new DaddyLiveProvider({
    circuitBreaker: { wrapSync: (_name, run) => ({ fire: run }) },
    iframeDomainRegistry: { terminalRefererFor: () => 'https://terminal.fixture.invalid/' }
  });
  provider.baseDomains = [BASE];
  provider.hdm1Slugs = slugs;
  const seen = { folderPages: 0, hdm1Pages: 0, urls: [], referers: [] };
  provider.proxyFetch = async (url, init) => {
    seen.urls.push(url);
    const parsed = new URL(url);
    if (parsed.origin === BASE && parsed.pathname.startsWith('/player/')) {
      seen.folderPages += 1;
      return { ok: true, text: async () => `<iframe src="${FOLDER_EMBED}"></iframe>` };
    }
    if (parsed.origin === 'https://wideiptv.top' && parsed.pathname.startsWith('/player/')) {
      seen.hdm1Pages += 1;
      seen.referers.push(init && init.headers && init.headers.Referer);
      if (!slugAlive) return { ok: true, text: async () => 'Channel not found or inactive. Looking for channel slug: TSN1' };
      return { ok: true, text: async () => `<script>const streamUrl = "${HDM1_MANIFEST}";</script>` };
    }
    if (url === FOLDER_EMBED) return { ok: true, text: async () => `<script>const streamUrl = "${FOLDER_MANIFEST}";</script>` };
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  return { provider, seen };
}

function manifestOf(streams, base) {
  expect(streams.length).toBe(1);
  return new URL(streams[0].url, base).searchParams.get('url');
}

describe('DaddyLive HDM1 verified-slug fast path', () => {
  test('mapped channel resolves from the wideiptv player page without any folder page', async () => {
    const { provider, seen } = fixture();
    const streams = await provider.resolveStream('111', 'hockey', 'TSN1');
    expect(manifestOf(streams, BASE)).toBe(HDM1_MANIFEST);
    expect(seen.folderPages).toBe(0);
    expect(seen.hdm1Pages).toBe(1);
    expect(seen.urls[0]).toBe('https://wideiptv.top/player/TSN1');
    expect(seen.referers[0]).toBe('https://wideiptv.top/daddy.php?stream=TSN1');
  });

  test('a mapped slug that is not found falls back to the folders', async () => {
    const { provider, seen } = fixture({ slugAlive: false });
    const streams = await provider.resolveStream('111', 'hockey', 'TSN1');
    expect(manifestOf(streams, BASE)).toBe(FOLDER_MANIFEST);
    expect(seen.hdm1Pages).toBe(1);
    expect(seen.folderPages).toBe(1);
  });

  test('an unmapped channel never touches wideiptv directly', async () => {
    const { provider, seen } = fixture();
    const streams = await provider.resolveStream('999999', 'hockey', 'Other');
    expect(manifestOf(streams, BASE)).toBe(FOLDER_MANIFEST);
    expect(seen.hdm1Pages).toBe(0);
    expect(seen.folderPages).toBe(1);
  });

  test('an unsafe slug in the map is ignored', async () => {
    const { provider, seen } = fixture({ slugs: { '111': '../evil?x=1' } });
    const streams = await provider.resolveStream('111', 'hockey', 'TSN1');
    expect(manifestOf(streams, BASE)).toBe(FOLDER_MANIFEST);
    expect(seen.hdm1Pages).toBe(0);
    expect(seen.urls.some(u => u.includes('evil'))).toBe(false);
  });

  test('DADDYLIVE_HDM1_FASTPATH=0 disables the route', () => {
    const previous = process.env.DADDYLIVE_HDM1_FASTPATH;
    process.env.DADDYLIVE_HDM1_FASTPATH = '0';
    try {
      const provider = new DaddyLiveProvider({ circuitBreaker: { wrapSync: (_n, run) => ({ fire: run }) } });
      expect(Object.keys(provider.hdm1Slugs).length).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.DADDYLIVE_HDM1_FASTPATH;
      else process.env.DADDYLIVE_HDM1_FASTPATH = previous;
    }
  });
});

describe('hdm1_slugs.json', () => {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'hdm1_slugs.json'), 'utf8'));
  const entries = Object.entries(map);

  test('has entries and every one is a numeric id with an alphanumeric slug', () => {
    expect(entries.length > 100).toBe(true);
    expect(entries.every(([id, slug]) => /^\d+$/.test(id) && /^[A-Za-z0-9]{1,64}$/.test(slug))).toBe(true);
  });

  test('excludes the ambiguous ids and keeps no two ids on the same slug', () => {
    expect('274' in map).toBe(false);
    expect('362' in map).toBe(false);
    const lower = entries.map(([, slug]) => slug.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  test('keeps the known-good TSN mappings', () => {
    expect(map['114']).toBe('TSN4');
    expect(map['111']).toBe('TSN1');
  });
});
