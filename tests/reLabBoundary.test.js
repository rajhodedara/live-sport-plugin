'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const GEMINI_MAX_BYTES = 6144;

const QUARANTINED_DIRS = new Set([
  'assets',
  'lib',
  'scorezone_src',
  'poster-drafts',
  'research',
]);

const QUARANTINED_ROOT_PATTERNS = [
  /^AndroidManifest\.xml$/i,
  /^androguard\.db$/i,
  /\.raw$/i,
  /\.cs3(?:\.zip)?$/i,
  /_disasm\.txt$/i,
  /_asm\.txt$/i,
  /^dex_all_strings\.txt$/i,
  /^disasm\.txt$/i,
  /^primary\.txt$/i,
  /^sxr_.*\.txt$/i,
  /^Lcom_.*\.txt$/i,
  /^sportzx_.*\.txt$/i,
  /_provider_plan_v\d+\.md$/i,
  /^trex_channels\.csv$/i,
  /^events(?:_fresh|_new)?\.json$/i,
  /^decrypted_output\.json$/i,
  /^pr81_meta\.json$/i,
  /^chunks_efto5Wzn\.js$/i,
];

const REQUIRED_GITIGNORE_RULES = [
  '/assets/',
  '/lib/',
  '/scorezone_src/',
  '/poster-drafts/',
  '/research/',
  'AndroidManifest.xml',
  'androguard.db',
  '*.raw',
  '*.cs3',
  '*_disasm.txt',
  '*_asm.txt',
  '*_provider_plan_v*.md',
];

describe('Reverse-engineering lab repository boundary', () => {
  test('GEMINI.md stays within 6144-byte budget and directs RE work to ../nuvio-re-lab', () => {
    const geminiPath = path.join(REPO_ROOT, 'GEMINI.md');
    const buf = fs.readFileSync(geminiPath);
    expect(buf.byteLength).toBeLessThanOrEqual(GEMINI_MAX_BYTES);
    expect(buf.toString('utf8')).toMatch(/nuvio-re-lab/i);
  });

  test('.gitignore quarantines reverse-engineering dump patterns and dirs', () => {
    const gitignore = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    const lines = new Set(
      gitignore
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    );

    for (const rule of REQUIRED_GITIGNORE_RULES) {
      expect(lines.has(rule)).toBe(true);
    }
  });

  test('repo root contains no quarantined reverse-engineering dumps or dirs', () => {
    const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
    const violations = [];

    for (const entry of entries) {
      if (entry.isDirectory() && QUARANTINED_DIRS.has(entry.name)) {
        violations.push(`${entry.name}/`);
      } else if (
        entry.isFile() &&
        QUARANTINED_ROOT_PATTERNS.some((pattern) => pattern.test(entry.name))
      ) {
        violations.push(entry.name);
      }
    }

    expect(violations).toEqual([]);
  });
});
