'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const wasmPath = path.resolve(__dirname, '../../cloudflare-worker/png-unfilter.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);

// Dynamically load cloudflare-worker/index.js
const workerCode = fs.readFileSync(path.resolve(__dirname, '../../cloudflare-worker/index.js'), 'utf8');
const transformed = workerCode
  .replace(/import\s*\{\s*connect\s*\}\s*from\s*['"]cloudflare:sockets['"];?/, 'const connect = () => ({});')
  .replace(/import\s+pngUnfilterWasm\s+from\s+['"]\.\/png-unfilter\.wasm['"];?/, 'const pngUnfilterWasm = wasmModule;')
  .replace(/export\s*\{[^}]+\};?/, '')
  .replace(/export\s+default\s+/, 'module.exports = ') +
  '\nmodule.exports.decodePngToTs = decodePngToTs;\nmodule.exports.inflatePngOnly = inflatePngOnly;\nmodule.exports.isPngBytes = isPngBytes;\n';

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

const { decodePngToTs } = m.exports;

function makeSyntheticPng(targetBytes, mode = 'deflate') {
  const width = 1000;
  const bpp = 3; // RGB
  const stride = width * bpp;
  const height = Math.ceil(targetBytes / stride);
  const rawLen = height * (stride + 1);
  const raw = Buffer.alloc(rawLen);

  // 70% filter 0, 10% sub, 10% up, 10% paeth
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1);
    raw[rowOff] = (y % 10 < 7) ? 0 : (y % 10 === 7 ? 1 : (y % 10 === 8 ? 2 : 4));
    for (let x = 1; x <= stride; x++) {
      raw[rowOff + x] = (x + y) & 0xff;
    }
  }

  // Prepend MPEG-TS sync byte at pixel 0
  raw[1] = 0x47;

  let zlibComp;
  if (mode === 'stored') {
    const chunks = [Buffer.from([0x78, 0x01])];
    let offset = 0;
    while (offset < raw.length) {
      const cLen = Math.min(raw.length - offset, 65535);
      const isLast = (offset + cLen >= raw.length);
      const hdr = Buffer.alloc(5);
      hdr[0] = isLast ? 1 : 0;
      hdr.writeUInt16LE(cLen, 1);
      hdr.writeUInt16LE((~cLen) & 0xffff, 3);
      chunks.push(hdr);
      chunks.push(raw.subarray(offset, offset + cLen));
      offset += cLen;
    }
    zlibComp = Buffer.concat(chunks);
  } else {
    zlibComp = zlib.deflateSync(raw);
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); // Dummy CRC
    return Buffer.concat([len, t, data, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', zlibComp),
    makeChunk('IEND', Buffer.alloc(0))
  ];

  return Buffer.concat(parts);
}

async function run() {
  console.log('--- LOCAL-ONLY Synthetic Benchmark: CPU vs Segment Size (Desktop Node 22 V8 x86_64, NOT Cloudflare edge telemetry) ---');
  const sizes = [
    { label: '300 KB (Low-res/audio)', bytes: 300 * 1024 },
    { label: '600 KB (480p rendition)', bytes: 600 * 1024 },
    { label: '1.0 MB (720p low)', bytes: 1024 * 1024 },
    { label: '1.5 MB (720p medium)', bytes: 1536 * 1024 },
    { label: '2.0 MB (1080p sports)', bytes: 2048 * 1024 },
    { label: '3.0 MB (1080p high sports)', bytes: 3072 * 1024 }
  ];

  for (const s of sizes) {
    const png = makeSyntheticPng(s.bytes, 'deflate');
    // Warmup
    await decodePngToTs(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));

    const iters = 5;
    const times = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await decodePngToTs(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`  ${s.label.padEnd(28)} | PNG size: ${(png.length / 1024).toFixed(0).padStart(5)} KB | Avg Decode CPU: ${avg.toFixed(2)} ms`);
  }

  console.log('\n--- Benchmarking Stored-Block Fast Path vs Size ---');
  for (const s of sizes) {
    const png = makeSyntheticPng(s.bytes, 'stored');
    const iters = 5;
    const times = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await decodePngToTs(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`  ${s.label.padEnd(28)} | Stored PNG: ${(png.length / 1024).toFixed(0).padStart(5)} KB | Avg Decode CPU: ${avg.toFixed(2)} ms`);
  }
}

run().catch(console.error);
