'use strict';

jest.mock('../src/services/DaddyLiveMediaCheck', () => ({
  checkDaddyLiveMedia: jest.fn(async () => ({ status: 'ok' }))
}));

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(async () => { throw new Error('Unexpected outbound request in folder-priority fixture'); })
}));

const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');

const BASE = 'https://daddy.fixture.invalid';
const PLAYER_EMBED = 'https://player-embed.fixture.invalid/live';
const CAST_EMBED = 'https://cast-embed.fixture.invalid/live';
const PLAYER_MANIFEST = 'https://player-cdn.fixture.invalid/live.m3u8?token=player';
const CAST_MANIFEST = 'https://cast-cdn.fixture.invalid/live.m3u8?token=cast';

function fixture({ knownTerminal = true, playerMiss } = {}) {
  const provider = new DaddyLiveProvider({
    circuitBreaker: { wrapSync: (_name, run) => ({ fire: run }) },
    iframeDomainRegistry: {
      terminalRefererFor: () => knownTerminal ? 'https://terminal.fixture.invalid/' : null
    }
  });
  provider.baseDomains = [BASE];
  provider.proxyFetch = jest.fn(async url => {
    const parsed = new URL(url);
    if (parsed.origin === BASE && parsed.pathname.startsWith('/player/')) {
      if (playerMiss === 'page404') return { ok: false, status: 404 };
      if (playerMiss === 'noIframe') return { ok: true, text: async () => '<html></html>' };
      return { ok: true, text: async () => `<iframe src="${PLAYER_EMBED}"></iframe>` };
    }
    if (parsed.origin === BASE && parsed.pathname.startsWith('/cast/')) {
      return { ok: true, text: async () => `<iframe src="${CAST_EMBED}"></iframe>` };
    }
    if (url === PLAYER_EMBED) {
      if (playerMiss === 'embed404') return { ok: false, status: 404 };
      return { ok: true, text: async () => `<script>const streamUrl = "${PLAYER_MANIFEST}";</script>` };
    }
    if (url === CAST_EMBED) {
      return { ok: true, text: async () => `<script>const streamUrl = "${CAST_MANIFEST}";</script>` };
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  return provider;
}

function target(streams) {
  expect(streams).toHaveLength(1);
  return new URL(streams[0].url, BASE).searchParams.get('url');
}

describe('DaddyLive default folder priority', () => {
  test.each(['38', '37'])('selects player before a decodable cast feed for channel %s', async channel => {
    const provider = fixture();
    const streams = await provider.resolveStream(channel, 'american_football', 'NFL fixture');

    expect(target(streams)).toBe(PLAYER_MANIFEST);
    expect(provider.proxyFetch.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/player/stream-${channel}.php`, PLAYER_EMBED
    ]);
  });

  test('keeps player priority when the terminal host is not registered', async () => {
    const provider = fixture({ knownTerminal: false });
    const streams = await provider.resolveStream('38', 'american_football', 'NFL fixture');

    expect(target(streams)).toBe(PLAYER_MANIFEST);
    expect(provider.proxyFetch).toHaveBeenCalledTimes(2);
  });

  test.each(['page404', 'embed404', 'noIframe'])('reaches cast when player misses with %s', async playerMiss => {
    const provider = fixture({ playerMiss });
    const streams = await provider.resolveStream('38', 'american_football', 'NFL fixture');
    const urls = provider.proxyFetch.mock.calls.map(([url]) => url);

    expect(target(streams)).toBe(CAST_MANIFEST);
    expect(urls[0]).toBe(`${BASE}/player/stream-38.php`);
    expect(urls).toContain(`${BASE}/cast/stream-38.php`);
    expect(urls.at(-1)).toBe(CAST_EMBED);
    expect(urls).toHaveLength(playerMiss === 'embed404' ? 4 : 3);
  });
});
