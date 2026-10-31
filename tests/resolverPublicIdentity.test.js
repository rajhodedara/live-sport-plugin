'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readResolverPublicIdentity } = require('../src/services/ResolverPublicIdentity');
const { createPinnedResolverIdentity } = require('../src/services/ResolverPinnedIdentity');
const { X509Certificate } = require('node:crypto');

const cert = fs.readFileSync(path.join(__dirname, 'fixtures/guarded-tls/cert.pem'));
const identityDirectory = path.resolve(path.parse(__dirname).root, 'resolver-identity-test');

test('each worker can load the same public certificate without reading a private key', () => {
  const read = jest.fn(() => cert);
  const first = readResolverPublicIdentity(identityDirectory, 'cdn.example.org', read);
  const second = readResolverPublicIdentity(identityDirectory, 'cdn.example.org', read);
  const certificatePath = path.join(identityDirectory, 'resolver.crt');
  expect(read.mock.calls).toEqual([[certificatePath], [certificatePath]]);
  expect(first).toEqual(second);
  expect(Object.isFrozen(first)).toBe(true);
  expect(createPinnedResolverIdentity(first)('cdn.example.org', new X509Certificate(cert).toLegacyObject())).toBeUndefined();
});

test('invalid identity configuration and unreadable or malformed certificates fail closed', () => {
  const traversingDirectory = `${identityDirectory}${path.sep}..${path.sep}bad`;
  expect(() => readResolverPublicIdentity(traversingDirectory, 'cdn.example.org', () => cert)).toThrow('Invalid resolver public identity configuration');
  expect(() => readResolverPublicIdentity(identityDirectory, 'bad host', () => cert)).toThrow('Invalid resolver public identity configuration');
  expect(() => readResolverPublicIdentity(identityDirectory, 'cdn.example.org', () => { throw new Error('private path'); })).toThrow('Resolver public certificate unavailable');
  expect(() => readResolverPublicIdentity(identityDirectory, 'cdn.example.org', () => Buffer.from('bad'))).toThrow('Resolver public certificate unavailable');
  expect(() => readResolverPublicIdentity(identityDirectory, 'cdn.example.org', () => Buffer.alloc(65537))).toThrow('Resolver public certificate unavailable');
});
