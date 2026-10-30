'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkRuntimeDirectory } = require('../scripts/check-resolver-runtime');

test('accepts only a private real directory owned by the expected user', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-perms-'));
  try {
    fs.chmodSync(root, 0o700);
    expect(checkRuntimeDirectory(root)).toBe(true);
    const occupied = path.join(root, 'resolver.sock');
    fs.writeFileSync(occupied, 'fixture');
    expect(checkRuntimeDirectory(root)).toBe(false);
    fs.unlinkSync(occupied);
    fs.symlinkSync(path.join(root, 'missing'), occupied);
    expect(checkRuntimeDirectory(root)).toBe(false);
    fs.unlinkSync(occupied);
    expect(checkRuntimeDirectory(root)).toBe(true);
    expect(checkRuntimeDirectory(root, fs.statSync(root).uid + 1)).toBe(false);
    fs.chmodSync(root, 0o755);
    expect(checkRuntimeDirectory(root)).toBe(false);
    const alias = root + '-link';
    try { fs.symlinkSync(root, alias); expect(checkRuntimeDirectory(alias)).toBe(false); }
    finally { fs.rmSync(alias, { force: true }); }
    expect(checkRuntimeDirectory(path.join(root, 'missing'))).toBe(false);
    expect(checkRuntimeDirectory('relative/path')).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
