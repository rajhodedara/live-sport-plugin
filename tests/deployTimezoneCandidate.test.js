'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const deployScript = fs.readFileSync(path.join(__dirname, '../scripts/deploy.sh'), 'utf8');
const previous = 'module.exports = { build: "previous", cache: "MATCHES_CACHE_PATH" };\n';
const candidate = 'module.exports = { build: "candidate", cache: "MATCHES_CACHE_PATH" };\n';
let root;

function write(relative, content, executable = false) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { mode: executable ? 0o755 : 0o644 });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-timezone-test-'));
  write('scripts/deploy.sh', deployScript);
  write('package.json', '{}\n');
  fs.mkdirSync(path.join(root, 'src'));
  write('dist/index.js', previous);
  // A previous interrupted build must never become this deployment's output.
  write('dist.next/index.js', candidate.replace('candidate', 'stale-candidate'));
  write('scripts/prepare-timezone-data.cjs', `
    require('node:fs').appendFileSync(process.env.EVENT_LOG, 'prepare\\n');
    if (process.env.PREFLIGHT_MODE === 'prepare-fail') process.exitCode = 1;
  `);
  write('scripts/check-timezone-runtime.cjs', `
    require('node:fs').appendFileSync(process.env.EVENT_LOG, 'runtime-check\\n');
    if (process.env.PREFLIGHT_MODE === 'runtime-fail') process.exitCode = 1;
  `);
  write('bin/git', `#!/bin/sh
case "$1" in
  rev-parse) printf 'stable\\n' ;;
  log) printf 'fixture-head\\n' ;;
  status) exit 0 ;;
  *) exit 23 ;;
esac
`, true);
  write('bin/curl', `#!/bin/sh
case "$*" in
  */api/matches*) printf '[]' ;;
esac
exit 0
`, true);
  write('bin/npm', `#!/bin/sh
printf 'build\\n' >> "$EVENT_LOG"
case "$BUILD_MODE" in
  fail) mkdir -p dist.next; printf 'partial' > dist.next/index.js; exit 1 ;;
  missing) exit 0 ;;
  syntax) mkdir -p dist.next; printf 'const = ; // MATCHES_CACHE_PATH' > dist.next/index.js ;;
  cache-missing) mkdir -p dist.next; printf 'module.exports = { build: "candidate" };' > dist.next/index.js ;;
  success) mkdir -p dist.next; printf '%s\\n' 'module.exports = { build: "candidate", cache: "MATCHES_CACHE_PATH" };' > dist.next/index.js ;;
  *) exit 24 ;;
esac
`, true);
  write('bin/pm2', `#!/bin/sh
if [ "$1" = reload ]; then
  printf 'reload\\n' >> "$EVENT_LOG"
  cat dist/index.js > "$RELOADED_ARTIFACT"
  exit 0
fi
exit 25
`, true);
  write('bin/mv', `#!/bin/sh
case "$*" in
  *'dist.next dist')
    if [ "$PROMOTION_RACE" = 1 ]; then
      mkdir -p dist
      printf 'concurrent artifact' > dist/concurrent.txt
    fi ;;
esac
exec /bin/mv "$@"
`, true);
  fs.symlinkSync(process.execPath, path.join(root, 'bin/node'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(buildMode, preflightMode = '', promotionRace = false) {
  const result = spawnSync('/bin/bash', ['scripts/deploy.sh', '--no-pull'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      TMPDIR: root,
      ICU_TIMEZONE_FILES_DIR: path.join(root, '.timezone-data/2026f-le'),
      EVENT_LOG: path.join(root, 'events.log'),
      RELOADED_ARTIFACT: path.join(root, 'reloaded.js'),
      BUILD_MODE: buildMode, PREFLIGHT_MODE: preflightMode,
      PROMOTION_RACE: promotionRace ? '1' : '0'
    }
  });
  expect(result.error).toBeUndefined();
  return { ...result, events: fs.existsSync(path.join(root, 'events.log'))
    ? fs.readFileSync(path.join(root, 'events.log'), 'utf8').trim().split('\n') : [] };
}

test('reload receives the newly verified candidate and retains the previous artifact', () => {
  const result = run('success');
  expect(result.status).toBe(0);
  expect(result.events).toEqual(['prepare', 'runtime-check', 'build', 'reload']);
  expect(fs.readFileSync(path.join(root, 'reloaded.js'), 'utf8')).toBe(candidate);
  expect(fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8')).toBe(candidate);
  expect(fs.readFileSync(path.join(root, 'dist.prev/index.js'), 'utf8')).toBe(previous);
});

test.each(['fail', 'missing', 'syntax', 'cache-missing'])('%s candidate keeps the old artifact and never reloads', mode => {
  const result = run(mode);
  expect(result.status).not.toBe(0);
  expect(result.events).toEqual(['prepare', 'runtime-check', 'build']);
  expect(fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8')).toBe(previous);
  expect(fs.existsSync(path.join(root, 'reloaded.js'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'dist.prev'))).toBe(false);
});

test.each(['prepare-fail', 'runtime-fail'])('%s stops before building or promoting a candidate', mode => {
  const result = run('success', mode);
  expect(result.status).not.toBe(0);
  expect(result.events).toEqual(mode === 'prepare-fail' ? ['prepare'] : ['prepare', 'runtime-check']);
  expect(fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8')).toBe(previous);
  expect(fs.existsSync(path.join(root, 'reloaded.js'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'dist.prev'))).toBe(false);
});

test('a destination appearing during promotion cannot nest the candidate or reach reload', () => {
  const result = run('success', '', true);
  expect(result.status).not.toBe(0);
  expect(result.events).toEqual(['prepare', 'runtime-check', 'build']);
  expect(fs.existsSync(path.join(root, 'reloaded.js'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'dist/dist.next'))).toBe(false);
  expect(fs.readFileSync(path.join(root, 'dist/concurrent.txt'), 'utf8')).toBe('concurrent artifact');
  expect(fs.readFileSync(path.join(root, 'dist.prev/index.js'), 'utf8')).toBe(previous);
  expect(fs.readFileSync(path.join(root, 'dist.next/index.js'), 'utf8')).toBe(candidate);
});
