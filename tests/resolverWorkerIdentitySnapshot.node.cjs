'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { provisionTestIdentity } = require('../src/services/ResolverIdentityProvision');
const { createConfiguredResolverTransport } = require('../src/services/ResolverTransportConfig');

test('worker transports retain the certificate loaded at initialization', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-worker-pins-'));
  try {
    const oldIdentity = provisionTestIdentity(root);
    const nextIdentity = provisionTestIdentity(root);
    const env = { RESOLVER_TRANSPORT: 'systemd-unix-tls', RESOLVER_CERT_DIR: oldIdentity.directory,
      RESOLVER_TLS_SERVERNAME: oldIdentity.expectedHost, RESOLVER_SOCKET_PATH: '/run/example/resolver.sock', RESOLVER_PORT: '7004' };
    const createClients = options => options.tlsIdentity;
    const workerOne = createConfiguredResolverTransport(env, { createClients });
    const workerTwo = createConfiguredResolverTransport(env, { createClients });
    assert.equal(workerOne.certificatePem, workerTwo.certificatePem);
    const original = workerOne.certificatePem;
    fs.copyFileSync(nextIdentity.certificatePath, oldIdentity.certificatePath);
    const restartedWorker = createConfiguredResolverTransport(env, { createClients });
    assert.equal(workerOne.certificatePem, original);
    assert.equal(workerTwo.certificatePem, original);
    assert.notEqual(restartedWorker.certificatePem, original);
    assert.equal(restartedWorker.certificatePem, fs.readFileSync(nextIdentity.certificatePath, 'utf8'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('separate worker processes report their own loaded fingerprints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-worker-process-'));
  try {
    const first = provisionTestIdentity(root), second = provisionTestIdentity(root);
    const modulePath = require.resolve('../src/services/ResolverTransportConfig');
    const code = `const { createConfiguredResolverTransport } = require(process.argv[1]);
      createConfiguredResolverTransport(process.env, { createClients: () => ({}) });`;
    const env = { ...process.env, RESOLVER_TRANSPORT: 'systemd-unix-tls',
      RESOLVER_CERT_DIR: first.directory, RESOLVER_TLS_SERVERNAME: first.expectedHost,
      RESOLVER_SOCKET_PATH: '/run/example/resolver.sock', RESOLVER_IDENTITY_DIAGNOSTICS: 'true' };
    const launch = () => {
      const result = spawnSync(process.execPath, ['-e', code, modulePath], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^\[ResolverIdentity\] /);
      return JSON.parse(result.stdout.replace(/^\[ResolverIdentity\] /, '').trim());
    };
    const workerOne = launch(), workerTwo = launch();
    assert.notEqual(workerOne.pid, workerTwo.pid);
    assert.equal(workerOne.sha256, workerTwo.sha256);
    fs.copyFileSync(second.certificatePath, first.certificatePath);
    const replacement = launch();
    const expected = createHash('sha256').update(new X509Certificate(fs.readFileSync(second.certificatePath)).raw).digest('hex');
    assert.equal(replacement.sha256, expected);
    assert.notEqual(replacement.sha256, workerOne.sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('opt-in worker diagnostics report the loaded DER fingerprint without credential data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-worker-diag-'));
  try {
    const identity = provisionTestIdentity(root);
    const logs = [];
    const env = { RESOLVER_TRANSPORT: 'systemd-unix-tls', RESOLVER_CERT_DIR: identity.directory,
      RESOLVER_TLS_SERVERNAME: identity.expectedHost, RESOLVER_SOCKET_PATH: '/run/example/resolver.sock',
      RESOLVER_IDENTITY_DIAGNOSTICS: 'true' };
    const deps = { createClients: options => options.tlsIdentity, identityLogger: (...args) => logs.push(args) };
    const loaded = createConfiguredResolverTransport(env, deps);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], '[ResolverIdentity]');
    const observed = JSON.parse(logs[0][1]);
    const expected = createHash('sha256').update(new X509Certificate(loaded.certificatePem).raw).digest('hex');
    assert.deepEqual(observed, { role: 'worker', pid: process.pid, sha256: expected });
    assert.ok(!JSON.stringify(logs).includes(identity.directory));
    assert.ok(!JSON.stringify(logs).includes('BEGIN CERTIFICATE'));
    logs.length = 0;
    createConfiguredResolverTransport({ ...env, RESOLVER_IDENTITY_DIAGNOSTICS: 'false' }, deps);
    assert.equal(logs.length, 0);
    assert.doesNotThrow(() => createConfiguredResolverTransport(env, { ...deps, identityLogger: () => { throw new Error('logger failure'); } }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
