'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provisionIsolatedResolver } = require('../scripts/provision-isolated-resolver');
const { checkRuntimeDirectory } = require('../scripts/check-resolver-runtime');

test('isolated provision creates matching private paths without overwriting an existing instance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-provision-'));
  try {
    const result = provisionIsolatedResolver('test1', { runtimeRoot: root });
    assert.equal(result.runtimeDir, path.join(root, 'nuvio-resolver-test-test1'));
    assert.equal(result.identityDir, path.join(result.runtimeDir, 'identity'));
    assert.equal(result.expectedHost, 'resolver.internal');
    assert.equal(checkRuntimeDirectory(result.runtimeDir), true);
    assert.equal(fs.statSync(path.join(result.identityDir, 'resolver.key')).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(path.join(result.identityDir, 'resolver.crt')));
    assert.throws(() => provisionIsolatedResolver('test1', { runtimeRoot: root }), { code: 'EEXIST' });
    assert.ok(fs.existsSync(path.join(result.identityDir, 'resolver.key')));
    for (const invalid of ['../production', 'a/b', '', 'UPPER', '-bad']) {
      assert.throws(() => provisionIsolatedResolver(invalid, { runtimeRoot: root }), /Invalid isolated resolver instance/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provisioning failure does not recursively remove the runtime directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-provision-'));
  try {
    assert.throws(() => provisionIsolatedResolver('bad', { runtimeRoot: root, provisionIdentity() { throw new Error('failure'); } }), /provisioning failed/);
    assert.ok(fs.statSync(path.join(root, 'nuvio-resolver-test-bad')).isDirectory());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
