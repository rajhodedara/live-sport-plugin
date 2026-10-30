'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const { createPinnedResolverIdentity } = require('../src/services/ResolverPinnedIdentity');

const pem = fs.readFileSync(path.join(__dirname, 'fixtures/guarded-tls/cert.pem'), 'utf8');
const peer = new X509Certificate(pem).toLegacyObject();

test('only the configured certificate and hostname pass the identity callback', () => {
  const verify = createPinnedResolverIdentity({ certificatePem: pem, expectedHost: 'cdn.example.org' });
  expect(verify('cdn.example.org', peer)).toBeUndefined();
  expect(verify('other.example.org', peer)).toBeInstanceOf(Error);
  const changedRaw = Buffer.from(peer.raw); changedRaw[changedRaw.length - 1] ^= 1;
  expect(verify('cdn.example.org', { ...peer, raw: changedRaw })).toBeInstanceOf(Error);
});

test('missing peer data and malformed configuration fail without leaking certificate data', () => {
  const verify = createPinnedResolverIdentity({ certificatePem: pem, expectedHost: 'cdn.example.org' });
  expect(verify('cdn.example.org', {})).toBeInstanceOf(Error);
  expect(String(verify('cdn.example.org', {}))).not.toContain('BEGIN CERTIFICATE');
  expect(() => createPinnedResolverIdentity({ certificatePem: 'invalid', expectedHost: 'cdn.example.org' })).toThrow();
  expect(() => createPinnedResolverIdentity({ certificatePem: pem, expectedHost: '' })).toThrow();
});

test('reusing a certificate cannot distinguish an older resolver epoch', () => {
  // The identity check receives a certificate, not a PID or generation. An
  // old resolver holding the same key presents the same authenticated identity.
  const currentEpoch = createPinnedResolverIdentity({ certificatePem: pem, expectedHost: 'cdn.example.org' });
  const oldEpochPeer = new X509Certificate(pem).toLegacyObject();
  expect(currentEpoch('cdn.example.org', oldEpochPeer)).toBeUndefined();
});
