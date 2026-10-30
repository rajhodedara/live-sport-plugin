'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { provisionTestIdentity } = require('../src/services/ResolverIdentityProvision');

// Isolated test setup only. Creating the runtime directory is exclusive: never
// reuse, overwrite or recursively delete an existing instance on failure.
function provisionIsolatedResolver(instance, dependencies = {}) {
  if (typeof instance !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
    throw new TypeError('Invalid isolated resolver instance');
  }
  const root = dependencies.runtimeRoot || '/run';
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root.includes('\0')) throw new TypeError('Invalid runtime root');
  const runtimeDir = path.join(root, `nuvio-resolver-test-${instance}`);
  // mkdir without recursive or force fails if anything already occupies it.
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  try {
    fs.chmodSync(runtimeDir, 0o700);
    const generation = (dependencies.provisionIdentity || provisionTestIdentity)(runtimeDir);
    const identityDir = path.join(runtimeDir, 'identity');
    // The private parent is freshly created; an existing destination is always
    // a conflict, even though rename could otherwise replace an empty directory.
    try { fs.lstatSync(identityDir); throw new Error('Identity destination occupied'); }
    catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    fs.renameSync(generation.directory, identityDir);
    return Object.freeze({ runtimeDir, identityDir, socketPath: path.join(runtimeDir, 'resolver.sock'), expectedHost: generation.expectedHost });
  } catch (_) {
    // Leave the newly created directory for explicit inspection; never remove
    // a potentially replaced path or a resource belonging to another process.
    throw new Error('Isolated resolver provisioning failed; inspect the newly created directory');
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new TypeError('Expected one isolated instance name');
    console.log(JSON.stringify(provisionIsolatedResolver(process.argv[2])));
  } catch (_) { console.error('Unable to provision isolated resolver instance'); process.exitCode = 1; }
}
module.exports = { provisionIsolatedResolver };
