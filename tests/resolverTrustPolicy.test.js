'use strict';

const { allowsLegacyResolverTcp, allowsResolverRouting, createResolverTrustGate } = require('../src/services/ResolverTrustPolicy');
const { createResolverConflictGate } = require('../src/services/ResolverConflictGate');
const StreamResolveCache = require('../src/services/StreamResolveCache');

test.each([{}, { RESOLVER_TRUST_LEGACY_TCP: 'false' }, { RESOLVER_TRUST_LEGACY_TCP: '1' }, { RESOLVER_TRUST_LEGACY_TCP: 'yes' }])('denies TCP proxy routing without explicit opt-in %#', env => {
  expect(allowsLegacyResolverTcp(env)).toBe(false);
  const next = jest.fn(), send = jest.fn();
  const res = { status: jest.fn(() => ({ send })) };
  createResolverTrustGate(env)({ url: '/stream?token=fixture' }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(503);
});

test('allows explicit compatibility TCP and configured pinned Unix TLS, without downgrading an invalid mode', () => {
  expect(allowsLegacyResolverTcp({ RESOLVER_TRUST_LEGACY_TCP: 'true' })).toBe(true);
  expect(allowsResolverRouting({ RESOLVER_TRANSPORT: 'systemd-unix-tls' })).toBe(true);
  expect(allowsLegacyResolverTcp({ RESOLVER_TRANSPORT: 'systemd-unix-tls', RESOLVER_TRUST_LEGACY_TCP: 'true' })).toBe(false);
  expect(allowsResolverRouting({ RESOLVER_TRANSPORT: 'invalid', RESOLVER_TRUST_LEGACY_TCP: 'true' })).toBe(false);
});

test('an observed resolver conflict dominates explicit TCP routing permission', () => {
  const next = jest.fn(), res = { status: jest.fn(() => ({ send: jest.fn() })) };
  createResolverTrustGate({ RESOLVER_TRUST_LEGACY_TCP: 'true' })({}, res,
    () => createResolverConflictGate({ hasConflict: () => true })({}, res, next));
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(503);
});

test('Unix mode without a constructed adapter cannot silently use the plaintext cache client', async () => {
  const previous = { mode: process.env.RESOLVER_TRANSPORT, trust: process.env.RESOLVER_TRUST_LEGACY_TCP, shared: process.env.RESOLVE_CACHE_SHARED, fetch: global.fetch };
  process.env.RESOLVER_TRANSPORT = 'systemd-unix-tls';
  process.env.RESOLVER_TRUST_LEGACY_TCP = 'true';
  process.env.RESOLVE_CACHE_SHARED = 'true';
  global.fetch = jest.fn();
  try {
    const cache = new StreamResolveCache();
    expect(await cache.getOrCreate('provider:fixture:source', async () => [{ url: 'https://example.test/' }])).toHaveLength(1);
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    global.fetch = previous.fetch;
    for (const [name, value] of [['RESOLVER_TRANSPORT', previous.mode], ['RESOLVER_TRUST_LEGACY_TCP', previous.trust], ['RESOLVE_CACHE_SHARED', previous.shared]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
