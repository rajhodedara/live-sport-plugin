'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const wasmPath = path.resolve(__dirname, '../../cloudflare-worker/png-unfilter.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);

// Dynamically load cloudflare-worker/index.js
const workerCode = fs.readFileSync(path.resolve(__dirname, '../../cloudflare-worker/index.js'), 'utf8');
const transformed = workerCode
  .replace(/import\s*\{\s*connect\s*\}\s*from\s*['"]cloudflare:sockets['"];?/, 'const connect = () => ({});')
  .replace(/import\s+pngUnfilterWasm\s+from\s+['"]\.\/png-unfilter\.wasm['"];?/, 'const pngUnfilterWasm = wasmModule;')
  .replace(/import\s*\{\s*inflateSync\s*\}\s*from\s+['"]node:zlib['"];?/, "const { inflateSync } = require('node:zlib');")
  .replace(/export\s*\{[^}]+\};?/, '')
  .replace(/export\s+default\s+/, 'module.exports = ') +
  '\nmodule.exports.decodePngToTs = decodePngToTs;\nmodule.exports.isPngBytes = isPngBytes;\n';

const m = { exports: {} };
const fn = new Function(
  'module', 'exports', 'require', 'WebAssembly', 'DecompressionStream',
  'Headers', 'Request', 'Response', 'URL', 'wasmModule',
  transformed
);
fn(
  m, m.exports, require, WebAssembly, globalThis.DecompressionStream,
  globalThis.Headers, globalThis.Request, globalThis.Response, globalThis.URL,
  wasmModule
);

const { decodePngToTs, isPngBytes } = m.exports;

async function run() {
  const fixturesDir = path.resolve(__dirname, '../../../nuvio-re-lab/fixtures');
  const refHashesPath = path.join(fixturesDir, 'reference_hashes.json');
  if (!fs.existsSync(refHashesPath)) {
    console.error('reference_hashes.json not found');
    process.exit(1);
  }

  const refHashes = JSON.parse(fs.readFileSync(refHashesPath, 'utf8'));
  console.log(`Verifying ${refHashes.length} fixtures with optimized decoder...`);

  let allMatched = true;
  for (const ref of refHashes) {
    const pngPath = path.join(fixturesDir, ref.file);
    const buf = fs.readFileSync(pngPath);

    const t0 = performance.now();
    const tsBytes = await decodePngToTs(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const dt = performance.now() - t0;

    const hash = crypto.createHash('sha256').update(Buffer.from(tsBytes)).digest('hex');
    const match = (hash === ref.tsSha256) && (tsBytes.byteLength === ref.tsSize);

    console.log(`[${match ? 'PASS' : 'FAIL'}] ${ref.file}: size=${tsBytes.byteLength} (dt=${dt.toFixed(2)}ms, hash=${hash.slice(0, 12)}...)`);
    if (!match) {
      console.error(`  Expected size=${ref.tsSize}, hash=${ref.tsSha256}`);
      console.error(`  Got      size=${tsBytes.byteLength}, hash=${hash}`);
      allMatched = false;
    }
  }

  if (allMatched) {
    console.log('\nAll 10 fixtures decoded with 100% BIT-FOR-BIT SHA-256 PARITY!');
  } else {
    process.exit(1);
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
