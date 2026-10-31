'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');

test('flat build boots guarded worker with local synthetic lock module', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-worker-'));
  const dist = path.join(root, 'dist.next');
  fs.mkdirSync(dist);
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.copyFileSync('src/providers/streamed_wasm_worker.js', path.join(dist, 'streamed_wasm_worker.js'));
  fs.writeFileSync(path.join(dist, 'lock.js'), 'export default async function init() {}\n');
  execFileSync(process.execPath, ['scripts/copy-guarded-worker-deps.js', dist]);
  const worker = new Worker(path.join(dist, 'streamed_wasm_worker.js'));
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not initialize')), 5000);
      worker.once('error', e => { clearTimeout(timer); reject(e); });
      worker.once('message', msg => { clearTimeout(timer); resolve(msg); });
    });
    expect(message).toEqual({ type: 'ready' });
  } finally { await worker.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);
