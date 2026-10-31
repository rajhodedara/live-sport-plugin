'use strict';
const { createConfiguredResolverTransport } = require('../src/services/ResolverTransportConfig');

test('legacy mode remains unchanged and unknown modes fail rather than downgrade', () => {
  const readIdentity = jest.fn(), createClients = jest.fn();
  expect(createConfiguredResolverTransport({}, { readIdentity, createClients })).toBeNull();
  expect(() => createConfiguredResolverTransport({ RESOLVER_TRANSPORT: 'misspelled' }, { readIdentity, createClients })).toThrow('Invalid resolver transport mode');
  expect(readIdentity).not.toHaveBeenCalled(); expect(createClients).not.toHaveBeenCalled();
});

test('protected mode passes only the public identity and the configured socket to the pinned client', () => {
  const identity = { certificatePem: 'fixture public certificate', expectedHost: 'resolver.example' };
  const readIdentity = jest.fn(() => identity), createClients = jest.fn(() => ({ configured: true }));
  const env = { RESOLVER_TRANSPORT: 'systemd-unix-tls', RESOLVER_CERT_DIR: '/run/credentials/test',
    RESOLVER_TLS_SERVERNAME: 'resolver.example', RESOLVER_SOCKET_PATH: '/run/nuvio-test/resolver.sock', RESOLVER_PORT: '7004' };
  expect(createConfiguredResolverTransport(env, { readIdentity, createClients })).toEqual({ configured: true });
  expect(readIdentity).toHaveBeenCalledWith(env.RESOLVER_CERT_DIR, env.RESOLVER_TLS_SERVERNAME);
  expect(createClients).toHaveBeenCalledWith({ socketPath: env.RESOLVER_SOCKET_PATH, legacyPort: '7004', tlsIdentity: identity });
});

test('missing or unreadable identity does not create a client or fall back to HTTP', () => {
  const createClients = jest.fn(), env = { RESOLVER_TRANSPORT: 'systemd-unix-tls' };
  expect(() => createConfiguredResolverTransport(env, { readIdentity: () => null, createClients })).toThrow('Resolver public certificate unavailable');
  expect(() => createConfiguredResolverTransport(env, { readIdentity: () => { throw new Error('missing'); }, createClients })).toThrow();
  expect(createClients).not.toHaveBeenCalled();
});
