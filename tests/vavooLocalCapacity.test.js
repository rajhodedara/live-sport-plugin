'use strict';

// Exercise the provider through the mocked shared guarded transport. No auth,
// resolver or catalog request leaves the fixture.
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn() }));

const { safeFetch } = require('../src/services/ProviderOutbound');
const VavooProvider = require('../src/providers/VavooProvider');
const { VavooTokenManager, VAVOO_BASE_SITES } = VavooProvider;
const CAPACITY_CODES = ['ERR_OUTBOUND_CAPACITY', 'ERR_NATIVE_POOL_BUSY', 'ERR_NATIVE_POOL_CAPACITY'];
const SOURCE = 'https://vavoo.to/vavoo-iptv/play/fixture';
const CDN = 'https://cdn.example.invalid/live/index.m3u8';
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const capacity = code => Object.assign(new Error('local guarded admission unavailable'), { code });
const upstreamFailure = () => Object.assign(new Error('fixture connection reset'), { code: 'ECONNRESET' });
const originalEnabled = process.env.VAVOO_ENABLED;

function setup(tokenManager) {
  const manager = tokenManager || {
    getOrRefreshSig: jest.fn(async () => 'fixture-signature'),
    _fetchDualSig: jest.fn(async () => ({ sig: 'refreshed-fixture-signature', validUntil: Date.now() + 900000 }))
  };
  const provider = new VavooProvider({ tokenManager: manager });
  provider.baseIndex = 0;
  return { provider, manager };
}

beforeEach(() => {
  process.env.VAVOO_ENABLED = 'true';
  jest.clearAllMocks();
  safeFetch.mockReset();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  if (originalEnabled === undefined) delete process.env.VAVOO_ENABLED;
  else process.env.VAVOO_ENABLED = originalEnabled;
  jest.restoreAllMocks();
});

describe('Vavoo local guarded capacity is not a mirror failure', () => {
  test.each(CAPACITY_CODES)('first mirror stops immediately and propagates the same %s error', async code => {
    const { provider, manager } = setup();
    const error = capacity(code);
    const source = Object.freeze({ id: SOURCE, channelName: 'Fixture', group: 'United Kingdom' });
    const before = JSON.stringify(source);
    safeFetch.mockRejectedValue(error);

    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture', source)).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toBe(`${VAVOO_BASE_SITES[0]}/mediahubmx-resolve.json`);
    expect(provider.baseIndex).toBe(0);
    expect(manager._fetchDualSig).not.toHaveBeenCalled();
    expect(JSON.stringify(source)).toBe(before);
  });

  test('preserves a wrapper error whose cause is local capacity', async () => {
    const { provider } = setup();
    const error = Object.assign(new Error('transport wrapper'), { cause: capacity('ERR_NATIVE_POOL_BUSY') });
    safeFetch.mockRejectedValue(error);
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture')).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(provider.baseIndex).toBe(0);
  });

  test('finds deep local-capacity causes without changing the outer error identity', async () => {
    const { provider, manager } = setup();
    let error = capacity('ERR_NATIVE_POOL_CAPACITY');
    for (let i = 0; i < 4; i++) error = Object.assign(new Error('transport wrapper'), { cause: error });
    safeFetch.mockRejectedValue(error);
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture')).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(provider.baseIndex).toBe(0);
    expect(manager._fetchDualSig).not.toHaveBeenCalled();
  });

  test('cyclic cause chains terminate and retain ordinary mirror-fallback behavior', async () => {
    const { provider } = setup();
    const error = new Error('first fixture wrapper');
    error.cause = Object.assign(new Error('second fixture wrapper'), { cause: error });
    safeFetch.mockRejectedValueOnce(error).mockResolvedValue(response(200, [{ url: CDN }]));
    expect(await provider.resolveStream(SOURCE, 'networks', 'Fixture')).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(provider.baseIndex).toBe(1);
  });

  test.each([
    ['HTTP503', () => response(503, {})],
    ['ordinary transport error', () => Promise.reject(upstreamFailure())],
    ['unclassified capacity-like message', () => Promise.reject(new Error('Native pool capacity reached'))]
  ])('retains normal mirror rotation after %s', async (_label, first) => {
    const { provider, manager } = setup();
    safeFetch.mockImplementationOnce(first).mockResolvedValue(response(200, [{ url: CDN }]));
    expect(await provider.resolveStream(SOURCE, 'networks', 'Fixture')).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(safeFetch.mock.calls[1][0]).toBe(`${VAVOO_BASE_SITES[1]}/mediahubmx-resolve.json`);
    expect(provider.baseIndex).toBe(1);
    expect(manager._fetchDualSig).not.toHaveBeenCalled();
  });

  test('still returns an empty result when all mirrors genuinely answer HTTP503', async () => {
    const { provider } = setup();
    safeFetch.mockResolvedValue(response(503, {}));
    expect(await provider.resolveStream(SOURCE, 'networks', 'Fixture')).toEqual([]);
    expect(safeFetch).toHaveBeenCalledTimes(VAVOO_BASE_SITES.length);
  });

  test.each(CAPACITY_CODES)('initial auth propagates %s without trying the auth fallback or resolver', async code => {
    const manager = new VavooTokenManager();
    const { provider } = setup(manager);
    const error = capacity(code);
    safeFetch.mockRejectedValue(error);
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture')).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(safeFetch.mock.calls[0][0]).toContain('vypn.net/api/app/ping');
    expect(manager.sig).toBeNull();
    expect(manager.refreshPromise).toBeNull();
    expect(provider.baseIndex).toBe(0);
  });

  test('auth fallback capacity preserves its error after an ordinary primary failure', async () => {
    const manager = new VavooTokenManager();
    const error = capacity('ERR_OUTBOUND_CAPACITY');
    const fetchFixture = jest.fn()
      .mockRejectedValueOnce(upstreamFailure())
      .mockRejectedValueOnce(error);
    await expect(manager.getOrRefreshSig(fetchFixture)).rejects.toBe(error);
    expect(fetchFixture).toHaveBeenCalledTimes(2);
    expect(fetchFixture.mock.calls[1][0]).toContain('lokke.app/api/app/ping');
    expect(manager.refreshPromise).toBeNull();
  });

  test('ordinary primary HTTP503 still permits a successful auth fallback', async () => {
    const manager = new VavooTokenManager();
    const fetchFixture = jest.fn()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(200, { addonSig: 'fixture-fallback-signature' }));
    expect(await manager.getOrRefreshSig(fetchFixture)).toBe('fixture-fallback-signature');
    expect(fetchFixture).toHaveBeenCalledTimes(2);
    expect(manager.activeSource).toBe('lokke.app');
  });

  test('a failed background refresh keeps a still-valid signature without auth fallback amplification', async () => {
    const manager = new VavooTokenManager();
    manager.sig = 'still-valid-fixture';
    manager.validUntil = Date.now() + 120000;
    const fetchFixture = jest.fn().mockRejectedValue(capacity('ERR_NATIVE_POOL_BUSY'));
    const signaturePromise = manager.getOrRefreshSig(fetchFixture);
    const refreshPromise = manager.refreshPromise;
    expect(await signaturePromise).toBe('still-valid-fixture');
    await refreshPromise;
    expect(fetchFixture).toHaveBeenCalledTimes(1);
    expect(manager.sig).toBe('still-valid-fixture');
    expect(manager.refreshPromise).toBeNull();
  });

  test.each(CAPACITY_CODES)('forced auth refresh propagates %s before rotating the mirror', async code => {
    const { provider, manager } = setup();
    const error = capacity(code);
    manager._fetchDualSig.mockRejectedValue(error);
    safeFetch.mockResolvedValue(response(401, {}));
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture')).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(manager._fetchDualSig).toHaveBeenCalledTimes(1);
    expect(provider.baseIndex).toBe(0);
  });

  test('ordinary forced-auth failure still allows the next mirror', async () => {
    const { provider, manager } = setup();
    manager._fetchDualSig.mockRejectedValue(upstreamFailure());
    safeFetch.mockResolvedValueOnce(response(403, {})).mockResolvedValueOnce(response(200, [{ url: CDN }]));
    expect(await provider.resolveStream(SOURCE, 'networks', 'Fixture')).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(provider.baseIndex).toBe(1);
  });

  test.each([true, false])('capacity during resolve body parsing is not swallowed (ok=%s)', async ok => {
    const { provider } = setup();
    const error = capacity('ERR_OUTBOUND_CAPACITY');
    safeFetch.mockResolvedValue({ ok, status: ok ? 200 : 404, json: async () => { throw error; } });
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture')).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(provider.baseIndex).toBe(0);
  });

  test.each(['initial catalog', 'group-less catalog', 'fresh fallback resolve'])('capacity in %s stops the fallback chain and mirror rotation', async stage => {
    const { provider, manager } = setup();
    const error = capacity('ERR_NATIVE_POOL_CAPACITY');
    safeFetch.mockResolvedValueOnce(response(404, {}));
    if (stage === 'group-less catalog') safeFetch.mockResolvedValueOnce(response(200, { items: [] }));
    if (stage === 'fresh fallback resolve') safeFetch.mockResolvedValueOnce(response(200, {
      items: [{ name: 'Fixture .c', url: 'https://vavoo.to/vavoo-iptv/play/fresh-fixture' }]
    }));
    safeFetch.mockRejectedValue(error);
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture', { id: SOURCE, group: 'United Kingdom' })).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(stage === 'initial catalog' ? 2 : 3);
    expect(safeFetch.mock.calls.every(([url]) => url.startsWith(VAVOO_BASE_SITES[0] + '/'))).toBe(true);
    expect(provider.baseIndex).toBe(0);
    expect(manager._fetchDualSig).not.toHaveBeenCalled();
  });

  test('catalog response parsing capacity does not trigger the group-less catalog retry', async () => {
    const { provider } = setup();
    const error = capacity('ERR_NATIVE_POOL_BUSY');
    safeFetch.mockResolvedValueOnce(response(404, {})).mockResolvedValue({
      ok: true, status: 200, json: async () => { throw error; }
    });
    await expect(provider.resolveStream(SOURCE, 'networks', 'Fixture', { id: SOURCE, group: 'United Kingdom' })).rejects.toBe(error);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  test('ordinary catalog network failure still allows the next resolver mirror', async () => {
    const { provider } = setup();
    safeFetch.mockResolvedValueOnce(response(404, {}))
      .mockRejectedValueOnce(upstreamFailure())
      .mockResolvedValue(response(200, [{ url: CDN }]));
    expect(await provider.resolveStream(SOURCE, 'networks', 'Fixture', { id: SOURCE, group: 'United Kingdom' })).toHaveLength(1);
    expect(safeFetch).toHaveBeenCalledTimes(3);
    expect(safeFetch.mock.calls[2][0]).toBe(`${VAVOO_BASE_SITES[1]}/mediahubmx-resolve.json`);
  });
});
