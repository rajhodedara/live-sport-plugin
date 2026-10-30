'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readResolverPublicIdentity } = require('../src/services/ResolverPublicIdentity');
const { createPinnedResolverIdentity } = require('../src/services/ResolverPinnedIdentity');
const { X509Certificate } = require('node:crypto');

const cert = fs.readFileSync(path.join(__dirname, 'fixtures/guarded-tls/cert.pem'));

test('each worker can load the same public certificate without reading a private key', () => {
  const read = jest.fn(() => cert);
  const first = readResolverPublicIdentity('/run/credentials/test', 'cdn.example.org', read);
  const second = readResolverPublicIdentity('/run/credentials/test', 'cdn.example.org', read);
  expect(read.mock.calls).toEqual([['/run/credentials/test/resolver.crt'], ['/run/credentials/test/resolver.crt']]);
  expect(first).toEqual(second);
  expect(Object.isFrozen(first)).toBe(true);
  expect(createPinnedResolverIdentity(first)('cdn.example.org', new X509Certificate(cert).toLegacyObject())).toBeUndefined();
});

test('invalid identity configuration and unreadable or malformed certificates fail closed', () => {
  expect(() => readResolverPublicIdentity('/run/test/../bad', 'cdn.example.org', () => cert)).toThrow('Invalid resolver public identity configuration');
  expect(() => readResolverPublicIdentity('/run/test', 'bad host', () => cert)).toThrow('Invalid resolver public identity configuration');
  expect(() => readResolverPublicIdentity('/run/test', 'cdn.example.org', () => { throw new Error('private path'); })).toThrow('Resolver public certificate unavailable');
  expect(() => readResolverPublicIdentity('/run/test', 'cdn.example.org', () => Buffer.from('bad'))).toThrow('Resolver public certificate unavailable');
  expect(() => readResolverPublicIdentity('/run/test', 'cdn.example.org', () => Buffer.alloc(65537))).toThrow('Resolver public certificate unavailable');
});
