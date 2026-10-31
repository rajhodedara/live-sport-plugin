'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { childScriptPath } = require('../src/services/IsolatedNativePoolCandidate');

test('build copy manifest includes both supervisor and child alongside guarded dependencies', () => {
  const copies = [], fakeFs = { mkdirSync: jest.fn(), copyFileSync: (source, destination) => copies.push([source, destination]) };
  const source = fs.readFileSync(path.join(__dirname, '../scripts/copy-guarded-worker-deps.js'), 'utf8');
  vm.runInNewContext(source, { process: { argv: ['node', 'script', 'output'] },
    require: name => name === 'node:fs' ? fakeFs : name === 'node:path' ? path : (() => { throw Error('unexpected import'); })() });
  expect(copies).toContainEqual(['src/services/IsolatedNativePoolCandidate.js', 'output/services/IsolatedNativePoolCandidate.js']);
  expect(copies).toContainEqual(['src/services/isolated-native-child.cjs', 'output/services/isolated-native-child.cjs']);
  expect(copies).toContainEqual(['src/services/NativeGuardedFetch.js', 'output/services/NativeGuardedFetch.js']);
  expect(copies).toContainEqual(['src/services/NativeTiming.js', 'output/services/NativeTiming.js']);
  expect(copies).toContainEqual(['src/services/TimingContext.js', 'output/services/TimingContext.js']);
  expect(copies).toContainEqual(['src/services/TimingOutput.js', 'output/services/TimingOutput.js']);
  expect(copies).toContainEqual(['src/services/TimingSnapshotTimer.js', 'output/services/TimingSnapshotTimer.js']);
  expect(copies).toContainEqual(['src/impitClient.js', 'output/impitClient.js']);
});

test('child path supports source services and the bundled output root', () => {
  expect(childScriptPath('/app/src/services', candidate => candidate === '/app/src/services/isolated-native-child.cjs'))
    .toBe('/app/src/services/isolated-native-child.cjs');
  expect(childScriptPath('/app/dist', () => false)).toBe('/app/dist/services/isolated-native-child.cjs');
});
