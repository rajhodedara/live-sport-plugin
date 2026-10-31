'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function copiedModule(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timing-module-'));
  const file = path.join(dir, `${name}.js`);
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'services', `${name}.js`), file);
  if (name === 'TimingRuntime') {
    for (const dependency of ['TimingRelations', 'TimingOutput', 'TimingSnapshotTimer']) {
      fs.copyFileSync(path.join(__dirname, '..', 'src', 'services', `${dependency}.js`), path.join(dir, `${dependency}.js`));
    }
  }
  return { module: require(file), cleanup: () => { delete require.cache[file]; fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('separate module copies share the same timing context inside one isolate', async () => {
  const original = require('../src/services/TimingContext');
  const copy = copiedModule('TimingContext');
  try {
    const work = { id: 'a'.repeat(32) };
    await original.withTimingWork(work, async () => {
      await Promise.resolve();
      expect(copy.module.currentTimingWork()).toBe(work.id);
    });
    expect(copy.module.currentTimingWork()).toBeNull();
  } finally { copy.cleanup(); }
});

test('separate runtime module copies share stream-to-cache relations', () => {
  const key = Symbol.for('nuvio.guardedTiming.relations.v1'), previous = globalThis[key];
  const previousFlag = process.env.STREAM_TIMING_EXPERIMENT;
  const originalPath = require.resolve('../src/services/TimingRuntime');
  const priorModule = require.cache[originalPath];
  const once = jest.spyOn(process, 'once').mockImplementation(() => process);
  delete globalThis[key]; delete require.cache[originalPath];
  process.env.STREAM_TIMING_EXPERIMENT = 'true';
  const copy = copiedModule('TimingRuntime');
  try {
    const original = require('../src/services/TimingRuntime');
    expect(original.relations).toBe(copy.module.relations);
    expect(once).toHaveBeenCalledTimes(1);
  } finally {
    copy.cleanup(); once.mockRestore(); delete require.cache[originalPath];
    if (priorModule) require.cache[originalPath] = priorModule;
    if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
    if (previousFlag === undefined) delete process.env.STREAM_TIMING_EXPERIMENT;
    else process.env.STREAM_TIMING_EXPERIMENT = previousFlag;
  }
});

test('separate output module copies use the same writer and session', () => {
  const key = Symbol.for('nuvio.guardedTiming.output.v1'), previous = globalThis[key];
  const once = jest.spyOn(process, 'once').mockImplementation(() => process);
  delete globalThis[key];
  const copy = copiedModule('TimingOutput');
  try {
    const original = require('../src/services/TimingOutput');
    expect(original.sharedTimingOutput()).toBe(copy.module.sharedTimingOutput());
    expect(once).toHaveBeenCalledTimes(1);
  } finally {
    copy.cleanup(); once.mockRestore();
    if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous;
  }
});
