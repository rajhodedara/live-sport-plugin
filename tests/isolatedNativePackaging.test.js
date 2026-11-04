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
  expect(copies).toContainEqual([path.join('src', 'services', 'IsolatedNativePoolCandidate.js'), path.join('output', 'services', 'IsolatedNativePoolCandidate.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'isolated-native-child.cjs'), path.join('output', 'services', 'isolated-native-child.cjs')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'NativeGuardedFetch.js'), path.join('output', 'services', 'NativeGuardedFetch.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'GuardedEgressPolicy.js'), path.join('output', 'services', 'GuardedEgressPolicy.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'GuardedCurlClient.js'), path.join('output', 'services', 'GuardedCurlClient.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'NativeTiming.js'), path.join('output', 'services', 'NativeTiming.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'TimingContext.js'), path.join('output', 'services', 'TimingContext.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'TimingOutput.js'), path.join('output', 'services', 'TimingOutput.js')]);
  expect(copies).toContainEqual([path.join('src', 'services', 'TimingSnapshotTimer.js'), path.join('output', 'services', 'TimingSnapshotTimer.js')]);
  expect(copies).toContainEqual([path.join('src', 'impitClient.js'), path.join('output', 'impitClient.js')]);
});

test('child path supports source services and the bundled output root', () => {
  const sourceServices = path.resolve('app', 'src', 'services');
  const sourceChild = path.join(sourceServices, 'isolated-native-child.cjs');
  const bundledOutput = path.resolve('app', 'dist');
  expect(childScriptPath(sourceServices, candidate => candidate === sourceChild)).toBe(sourceChild);
  expect(childScriptPath(bundledOutput, () => false)).toBe(path.join(bundledOutput, 'services', 'isolated-native-child.cjs'));
});
