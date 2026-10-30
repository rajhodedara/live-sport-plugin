'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Isolated example precondition, not a defence against same-UID replacement.
function checkRuntimeDirectory(directory, expectedUid = process.getuid?.()) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory ||
      directory.includes('\0') || !Number.isInteger(expectedUid) || expectedUid < 0) return false;
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o7777) !== 0o700) return false;
    // Do not let the example unit start over any pre-existing path, including
    // a dangling symlink. This check is not atomic with systemd's later bind.
    try { fs.lstatSync(path.join(directory, 'resolver.sock')); return false; }
    catch (failure) { return failure.code === 'ENOENT'; }
  } catch (_) { return false; }
}

if (require.main === module && !checkRuntimeDirectory(process.argv[2])) {
  console.error('Isolated resolver runtime directory is missing or not private');
  process.exitCode = 1;
}
module.exports = { checkRuntimeDirectory };
