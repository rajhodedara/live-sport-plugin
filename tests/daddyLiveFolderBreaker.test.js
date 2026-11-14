'use strict';

jest.mock('../src/services/DaddyLiveMediaCheck', () => ({
  checkDaddyLiveMedia: jest.fn(async () => ({ status: 'ok' }))
}));

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(async () => { throw new Error('Unexpected outbound request in folder-breaker fixture'); })
}));

const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const FolderProbeBreaker = require('../src/services/FolderProbeBreaker');

const BASE = 'https://daddy.fixture.invalid';
const PLAYER_EMBED = 'https://player-embed.fixture.invalid/live';
const CAST_EMBED = 'https://cast-embed.fixture.invalid/live';
const PLAYER_MANIFEST = 'https://player-cdn.fixture.invalid/live.m3u8?token=player';
const CAST_MANIFEST = 'https://cast-cdn.fixture.invalid/live.m3u8?token=cast';

describe('FolderProbeBreaker', () => {
  function make(extra) {
    const clock = { t: 1000 };
    const breaker = new FolderProbeBreaker({ failureThreshold: 3, openMs: 5000, quietMs: 10000, now: () => clock.t, ...extra });
    return { clock, breaker };
  }

  test('stays closed below the threshold and a hit resets the count', () => {
    const { breaker } = make();
    breaker.recordMiss('k'); breaker.recordMiss('k');
    breaker.recordHit('k');
    breaker.recordMiss('k'); breaker.recordMiss('k');
    expect(breaker.shouldSkip('k')).toBe(false);
  });

  test('opens after N consecutive misses and skips until the pause ends', () => {
    const { breaker, clock } = make();
    breaker.recordMiss('k'); breaker.recordMiss('k');
    expect(breaker.recordMiss('k')).toBe(true);
    expect(breaker.shouldSkip('k')).toBe(true);
    clock.t += 4999;
    expect(breaker.shouldSkip('k')).toBe(true);
  });

  test('half-open lets exactly one probe through; a miss re-opens at once', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.recordMiss('k');
    clock.t += 5000;
    expect(breaker.shouldSkip('k')).toBe(false);
    expect(breaker.shouldSkip('k')).toBe(true);
    expect(breaker.recordMiss('k')).toBe(true);
    expect(breaker.shouldSkip('k')).toBe(true);
  });

  test('half-open hit closes the breaker', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.recordMiss('k');
    clock.t += 5000;
    expect(breaker.shouldSkip('k')).toBe(false);
    expect(breaker.recordHit('k')).toBe(true);
    expect(breaker.shouldSkip('k')).toBe(false);
    expect(breaker.shouldSkip('k')).toBe(false);
  });

  test('an inconclusive half-open probe frees the slot without a verdict', () => {
    const { breaker, clock } = make();
    for (let i = 0; i < 3; i++) breaker.recordMiss('k');
    clock.t += 5000;
    expect(breaker.shouldSkip('k')).toBe(false);
    breaker.recordInconclusive('k');
    expect(breaker.shouldSkip('k')).toBe(false);
  });

  test('a folder that produced a hit recently is not opened by a later miss streak', () => {
    const { breaker, clock } = make();
    breaker.recordHit('k');
    clock.t += 9000;
    for (let i = 0; i < 5; i++) breaker.recordMiss('k');
    expect(breaker.shouldSkip('k')).toBe(false);
    clock.t += 1500;
    expect(breaker.recordMiss('k')).toBe(true);
    expect(breaker.shouldSkip('k')).toBe(true);
  });

  test('keys are independent', () => {
    const { breaker } = make();
    for (let i = 0; i < 3; i++) breaker.recordMiss('a');
    expect(breaker.shouldSkip('a')).toBe(true);
    expect(breaker.shouldSkip('b')).toBe(false);
  });
});

describe('DaddyLive folder breaker integration', () => {
  function fixture({ playerBody = '<html></html>', playerStatus = 200 } = {}) {
    const clock = { t: 1000 };
    const provider = new DaddyLiveProvider({
      circuitBreaker: { wrapSync: (_name, run) => ({ fire: run }) },
      iframeDomainRegistry: { terminalRefererFor: () => 'https://terminal.fixture.invalid/' }
    });
    provider.baseDomains = [BASE];
    provider.folderBreaker = new FolderProbeBreaker({ failureThreshold: 3, openMs: 5000, quietMs: 10000, now: () => clock.t });
    const state = { playerPages: 0, castPages: 0, playerBody, playerStatus };
    provider.proxyFetch = async url => {
      const parsed = new URL(url);
      if (parsed.origin === BASE && parsed.pathname.startsWith('/player/')) {
        state.playerPages += 1;
        if (state.playerStatus !== 200) return { ok: false, status: state.playerStatus };
        return { ok: true, text: async () => state.playerBody };
      }
      if (parsed.origin === BASE && parsed.pathname.startsWith('/cast/')) {
        state.castPages += 1;
        return { ok: true, text: async () => `<iframe src="${CAST_EMBED}"></iframe>` };
      }
      if (url === PLAYER_EMBED) return { ok: true, text: async () => `<script>const streamUrl = "${PLAYER_MANIFEST}";</script>` };
      if (url === CAST_EMBED) return { ok: true, text: async () => `<script>const streamUrl = "${CAST_MANIFEST}";</script>` };
      throw new Error(`Unexpected fixture URL: ${url}`);
    };
    return { provider, state, clock };
  }

  test('stops downloading a folder page that keeps coming back empty, and still resolves via the next folder', async () => {
    const { provider, state } = fixture();
    for (const id of ['1', '2', '3']) await provider.resolveStream(id, 'football', 'Fixture');
    expect(state.playerPages).toBe(3);

    const streams = await provider.resolveStream('4', 'football', 'Fixture');
    expect(state.playerPages).toBe(3);
    expect(state.castPages).toBe(4);
    expect(streams.length).toBe(1);
  });

  test('re-probes after the pause and resumes once the folder answers again', async () => {
    const { provider, state, clock } = fixture();
    for (const id of ['1', '2', '3', '4']) await provider.resolveStream(id, 'football', 'Fixture');
    expect(state.playerPages).toBe(3);

    clock.t += 5000;
    state.playerBody = `<iframe src="${PLAYER_EMBED}"></iframe>`;
    await provider.resolveStream('5', 'football', 'Fixture');
    expect(state.playerPages).toBe(4);

    await provider.resolveStream('6', 'football', 'Fixture');
    expect(state.playerPages).toBe(5);
  });

  test('HTTP failures never count as misses', async () => {
    const { provider, state } = fixture({ playerStatus: 503 });
    for (const id of ['1', '2', '3', '4', '5']) await provider.resolveStream(id, 'football', 'Fixture');
    expect(state.playerPages).toBe(5);
  });

  test('a working folder is never paused', async () => {
    const { provider, state } = fixture({ playerBody: `<iframe src="${PLAYER_EMBED}"></iframe>` });
    for (const id of ['1', '2', '3', '4', '5']) await provider.resolveStream(id, 'football', 'Fixture');
    expect(state.playerPages).toBe(5);
    expect(state.castPages).toBe(0);
  });
});
