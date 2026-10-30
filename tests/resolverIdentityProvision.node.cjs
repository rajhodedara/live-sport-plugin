'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const https = require('node:https');
const { provisionTestIdentity } = require('../src/services/ResolverIdentityProvision');
const { createPinnedResolverIdentity } = require('../src/services/ResolverPinnedIdentity');

test('fresh isolated identities do not authenticate the previous generation', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-identity-test-'));
  try {
    const a = provisionTestIdentity(parent), b = provisionTestIdentity(parent);
    const certA = fs.readFileSync(a.certificatePath, 'utf8');
    const certB = fs.readFileSync(b.certificatePath, 'utf8');
    const verify = createPinnedResolverIdentity({ certificatePem: certB, expectedHost: b.expectedHost });
    assert.notEqual(a.directory, b.directory);
    assert.equal(fs.statSync(b.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(b.keyPath).mode & 0o777, 0o600);
    assert.equal(verify(b.expectedHost, new X509Certificate(certB).toLegacyObject()), undefined);
    assert.ok(verify(b.expectedHost, new X509Certificate(certA).toLegacyObject()) instanceof Error);
    // Never start a resolver with credentials accidentally mixed across epochs.
    assert.throws(() => https.createServer({ cert: certA, key: fs.readFileSync(b.keyPath) }), /key values mismatch|KEY_VALUES_MISMATCH/i);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('failed provisioning removes only the newly created test generation', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-identity-test-'));
  try {
    assert.throws(() => provisionTestIdentity(parent, { run() { throw new Error('sensitive'); } }), /Resolver test identity provisioning failed/);
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});
