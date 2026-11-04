'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Isolated-test helper only. Each invocation makes a fresh private directory;
// it never overwrites another generation. Its parent must already be trusted.
// Same-user/root processes can access the key: this is not a privilege boundary.
function provisionTestIdentity(parent, dependencies = {}) {
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || path.normalize(parent) !== parent || parent.includes('\0')) {
    throw new TypeError('Invalid resolver identity directory');
  }
  const run = dependencies.run || execFileSync;
  const directory = fs.mkdtempSync(path.join(parent, 'resolver-identity-'));
  try {
    fs.chmodSync(directory, 0o700);
    const key = path.join(directory, 'resolver.key');
    const cert = path.join(directory, 'resolver.crt');
    run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=resolver.internal',
      '-addext', 'subjectAltName=DNS:resolver.internal'], { stdio: 'ignore', timeout: 10000 });
    fs.chmodSync(key, 0o600); fs.chmodSync(cert, 0o600);
    return Object.freeze({ directory, certificatePath: cert, keyPath: key, expectedHost: 'resolver.internal' });
  } catch (_) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) {}
    throw new Error('Resolver test identity provisioning failed');
  }
}

module.exports = { provisionTestIdentity };
