'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const wasmPath = path.resolve(__dirname, '../cloudflare-worker/png-unfilter.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);

// Dynamically load cloudflare-worker/index.js with mocked environment for test isolation
function loadWorker() {
  const code = fs.readFileSync(path.resolve(__dirname, '../cloudflare-worker/index.js'), 'utf8');
  const transformed = code
    .replace(/import\s*\{\s*connect\s*\}\s*from\s*['"]cloudflare:sockets['"];?/, 'const connect = () => ({ writable: { getWriter: () => {} }, readable: { getReader: () => {} } });')
    .replace(/import\s+pngUnfilterWasm\s+from\s+['"]\.\/png-unfilter\.wasm['"];?/, 'const pngUnfilterWasm = wasmModule;')
    .replace(/export\s*\{[^}]+\};?/, '')
    .replace(/export\s+default\s+/, 'module.exports = ') +
    '\nmodule.exports.decodePngToTs = decodePngToTs;\nmodule.exports.inflatePngOnly = typeof inflatePngOnly !== "undefined" ? inflatePngOnly : undefined;\nmodule.exports.isPngBytes = isPngBytes;\n';

  const m = { exports: {} };
  // Do NOT shadow fetch so it resolves dynamically to globalThis.fetch
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
  return m.exports;
}

const worker = loadWorker();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = crc32(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, body, crcBuf]);
}

function makeTsPacket(byteVal = 0xAA) {
  const packet = Buffer.alloc(188);
  packet[0] = 0x47;
  for (let i = 1; i < 188; i++) packet[i] = (byteVal + i) & 255;
  return packet;
}

function makeKwp1Payload(tsData) {
  const kwp1 = Buffer.alloc(8 + tsData.length);
  kwp1.write('KWP1', 0, 4, 'ascii');
  kwp1.writeUInt32BE(tsData.length, 4);
  tsData.copy(kwp1, 8);
  return kwp1;
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function filterScanlines(unfiltered, width, height, bpp, filterPattern) {
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  let prevRow = null;

  for (let y = 0; y < height; y++) {
    const ft = filterPattern[y % filterPattern.length];
    const rowOffset = y * stride;
    const curRow = unfiltered.subarray(rowOffset, rowOffset + stride);
    const rawRowOffset = y * (stride + 1);
    raw[rawRowOffset] = ft;

    for (let x = 0; x < stride; x++) {
      const xVal = curRow[x];
      const a = x >= bpp ? curRow[x - bpp] : 0;
      const b = prevRow ? prevRow[x] : 0;
      const c = (x >= bpp && prevRow) ? prevRow[x - bpp] : 0;

      let pred = 0;
      if (ft === 0) pred = 0;
      else if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) pred = paethPredictor(a, b, c);

      raw[rawRowOffset + 1 + x] = (xVal - pred) & 255;
    }
    prevRow = curRow;
  }
  return raw;
}

function buildSyntheticPng({
  width,
  height,
  colorType = 2,
  filterPattern = [0],
  payloadData,
  splitIdat = 1,
  kwLn = null,
  corruptSignature = false,
  corruptIhdr = false,
  useStoredDeflate = false,
  badStoredLen = false
}) {
  const bppMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  const keep = (colorType === 4) ? 1 : ((colorType === 6) ? 3 : bpp);
  const stride = width * bpp;
  const uncompressedPixels = Buffer.alloc(height * stride);

  const payloadBytes = Buffer.isBuffer(payloadData) ? payloadData : Buffer.from(payloadData);
  let pOff = 0;
  for (let dst = 0; dst < height * width * bpp; dst += bpp) {
    for (let k = 0; k < keep; k++) {
      uncompressedPixels[dst + k] = (pOff < payloadBytes.length) ? payloadBytes[pOff++] : 0;
    }
    if (colorType === 4 || colorType === 6) {
      uncompressedPixels[dst + keep] = 255; // Opaque alpha
    }
  }

  const raw = filterScanlines(uncompressedPixels, width, height, bpp, filterPattern);

  let zlibComp;
  if (useStoredDeflate) {
    const chunks = [Buffer.from([0x78, 0x01])];
    let offset = 0;
    while (offset < raw.length) {
      const cLen = Math.min(raw.length - offset, 65535);
      const isLast = (offset + cLen >= raw.length);
      const hdr = Buffer.alloc(5);
      hdr[0] = isLast ? 1 : 0;
      hdr.writeUInt16LE(cLen, 1);
      const nlen = badStoredLen ? (cLen ^ 0x1234) : ((~cLen) & 0xffff);
      hdr.writeUInt16LE(nlen, 3);
      chunks.push(hdr);
      chunks.push(raw.subarray(offset, offset + cLen));
      offset += cLen;
    }
    let a = 1, b = 0;
    for (let i = 0; i < raw.length; i++) {
      a = (a + raw[i]) % 65521;
      b = (b + a) % 65521;
    }
    const adler = Buffer.alloc(4);
    adler.writeUInt32BE(((b << 16) | a) >>> 0, 0);
    chunks.push(adler);
    zlibComp = Buffer.concat(chunks);
  } else {
    zlibComp = zlib.deflateSync(raw);
  }

  const sig = corruptSignature
    ? Buffer.from([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts = [sig, makeChunk('IHDR', corruptIhdr ? ihdr.subarray(0, 5) : ihdr)];

  if (kwLn !== null) {
    const kwLnBuf = Buffer.alloc(4);
    kwLnBuf.writeUInt32BE(kwLn, 0);
    parts.push(makeChunk('kwLn', kwLnBuf));
  }

  if (splitIdat > 1) {
    const chunkSize = Math.ceil(zlibComp.length / splitIdat);
    for (let i = 0; i < zlibComp.length; i += chunkSize) {
      parts.push(makeChunk('IDAT', zlibComp.subarray(i, i + chunkSize)));
    }
  } else {
    parts.push(makeChunk('IDAT', zlibComp));
  }

  parts.push(makeChunk('IEND', Buffer.alloc(0)));
  return { png: Buffer.concat(parts), raw, tsData: payloadBytes };
}

describe('pngWorkerFastPath Decoder Core', () => {
  test('parses all 5 filters across supported byte widths (1, 2, 3, 4) with byte-exact parity', async () => {
    const configs = [
      { colorType: 0, bpp: 1, w: 20, h: 10 },
      { colorType: 4, bpp: 2, w: 20, h: 10 },
      { colorType: 2, bpp: 3, w: 20, h: 10 },
      { colorType: 6, bpp: 4, w: 20, h: 10 }
    ];

    for (const cfg of configs) {
      const ts = makeTsPacket(0x10 * cfg.bpp);
      const kwp1 = makeKwp1Payload(ts);
      const { png } = buildSyntheticPng({
        width: cfg.w,
        height: cfg.h,
        colorType: cfg.colorType,
        filterPattern: [0, 1, 2, 3, 4],
        payloadData: kwp1,
        kwLn: kwp1.length
      });

      const decoded = await worker.decodePngToTs(png);
      expect(Buffer.from(decoded)).toEqual(ts);
      expect(decoded[0]).toBe(0x47);
      expect(decoded.length).toBe(188);
    }
  });

  test('handles multi-IDAT chunk splitting crossing block and zlib headers', async () => {
    const ts = Buffer.concat([makeTsPacket(0x21), makeTsPacket(0x42)]);
    const kwp1 = makeKwp1Payload(ts);
    const { png } = buildSyntheticPng({
      width: 24,
      height: 18,
      colorType: 2,
      filterPattern: [2, 4, 1, 0, 3],
      payloadData: kwp1,
      splitIdat: 5,
      kwLn: kwp1.length
    });

    const decoded = await worker.decodePngToTs(png);
    expect(Buffer.from(decoded)).toEqual(ts);
    expect(decoded.length).toBe(376);
  });

  test('correctly unwraps raw 188-byte aligned MPEG-TS without KWP1 header', async () => {
    const ts = Buffer.concat([makeTsPacket(0x33), makeTsPacket(0x77)]);
    const { png } = buildSyntheticPng({
      width: 20,
      height: 20,
      colorType: 2,
      filterPattern: [0],
      payloadData: ts
    });

    const decoded = await worker.decodePngToTs(png);
    expect(Buffer.from(decoded)).toEqual(ts);
    expect(decoded.length).toBe(376);
  });

  test('executes stored-block fast path on fully stored DEFLATE stream with byte parity', async () => {
    const ts = makeTsPacket(0x88);
    const kwp1 = makeKwp1Payload(ts);
    const { png } = buildSyntheticPng({
      width: 16,
      height: 16,
      colorType: 2,
      filterPattern: [0],
      payloadData: kwp1,
      kwLn: kwp1.length,
      useStoredDeflate: true
    });

    const decoded = await worker.decodePngToTs(png);
    expect(Buffer.from(decoded)).toEqual(ts);
  });

  test('falls back safely to general decoder on mixed stored + dynamic blocks', async () => {
    const fixPath = path.resolve(__dirname, '../../nuvio-re-lab/fixtures/fixture_2777051_0.png');
    if (fs.existsSync(fixPath)) {
      const fixBuf = fs.readFileSync(fixPath);
      const decoded = await worker.decodePngToTs(fixBuf);
      const refHash = '87725d3f773c9c6d8c93b9c37f602327d22cdd021b6e25fd78a65c271502d5f1';
      const decodedHash = crypto.createHash('sha256').update(decoded).digest('hex');
      expect(decodedHash).toBe(refHash);
    }
  });

  test('rejects malformed PNG signature or truncated IHDR', async () => {
    const ts = makeTsPacket(0x99);
    const { png: badSig } = buildSyntheticPng({
      width: 10,
      height: 10,
      payloadData: ts,
      corruptSignature: true
    });

    const res = await worker.decodePngToTs(badSig);
    expect(res[0]).not.toBe(0x47);

    const { png: badIhdr } = buildSyntheticPng({
      width: 10,
      height: 10,
      payloadData: ts,
      corruptIhdr: true
    });
    await expect(worker.decodePngToTs(badIhdr)).rejects.toThrow();
  });

  test('rejects bad stored block LEN/NLEN mismatch', async () => {
    const ts = makeTsPacket(0x55);
    const { png } = buildSyntheticPng({
      width: 10,
      height: 10,
      payloadData: ts,
      useStoredDeflate: true,
      badStoredLen: true
    });
    await expect(worker.decodePngToTs(png)).rejects.toThrow();
  });

  test('aborts on truncated or oversized inflation', async () => {
    const oversizedRaw = Buffer.alloc(1000);
    const zlibOversized = zlib.deflateSync(oversizedRaw);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(10, 0);
    ihdr.writeUInt32BE(10, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const oversizedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', ihdr),
      makeChunk('IDAT', zlibOversized),
      makeChunk('IEND', Buffer.alloc(0))
    ]);
    await expect(worker.decodePngToTs(oversizedPng)).rejects.toThrow(/exceeded expected/);

    const truncRaw = Buffer.alloc(100);
    const zlibTrunc = zlib.deflateSync(truncRaw);
    const truncPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', ihdr),
      makeChunk('IDAT', zlibTrunc),
      makeChunk('IEND', Buffer.alloc(0))
    ]);
    await expect(worker.decodePngToTs(truncPng)).rejects.toThrow(/does not match expected/);
  });

  test('concurrent Promise.all decodes with distinct inputs never cross-contaminate', async () => {
    const tasks = [
      { byteVal: 0x11, w: 16, h: 16, colorType: 2 },
      { byteVal: 0x33, w: 20, h: 20, colorType: 0 },
      { byteVal: 0x77, w: 18, h: 18, colorType: 6 },
      { byteVal: 0x99, w: 24, h: 24, colorType: 4 }
    ];

    const promises = tasks.map(async (t) => {
      const ts = makeTsPacket(t.byteVal);
      const kwp1 = makeKwp1Payload(ts);
      const { png } = buildSyntheticPng({
        width: t.w,
        height: t.h,
        colorType: t.colorType,
        filterPattern: [0, 2, 4, 1],
        payloadData: kwp1,
        kwLn: kwp1.length
      });
      const decoded = await worker.decodePngToTs(png);
      return { ts, decoded };
    });

    const results = await Promise.all(promises);
    for (const { ts, decoded } of results) {
      expect(Buffer.from(decoded)).toEqual(ts);
    }
  });

  test('delayed body-consumption retains independent result after subsequent decode completes', async () => {
    const tsA = makeTsPacket(0xAA);
    const kwp1A = makeKwp1Payload(tsA);
    const { png: pngA } = buildSyntheticPng({
      width: 16,
      height: 16,
      colorType: 2,
      payloadData: kwp1A,
      kwLn: kwp1A.length
    });

    const tsB = makeTsPacket(0xBB);
    const kwp1B = makeKwp1Payload(tsB);
    const { png: pngB } = buildSyntheticPng({
      width: 20,
      height: 20,
      colorType: 2,
      payloadData: kwp1B,
      kwLn: kwp1B.length
    });

    const decodedA = await worker.decodePngToTs(pngA);
    const decodedB = await worker.decodePngToTs(pngB);

    expect(Buffer.from(decodedA)).toEqual(tsA);
    expect(Buffer.from(decodedB)).toEqual(tsB);
  });
});

describe('Worker-Level HTTP Endpoint Regressions', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  test('ordinary PNG GET returns 200 video/mp2t, byte-exact TS, exact Content-Length, and no Range headers', async () => {
    const ts = makeTsPacket(0x66);
    const kwp1 = makeKwp1Payload(ts);
    const { png } = buildSyntheticPng({
      width: 16,
      height: 16,
      colorType: 2,
      payloadData: kwp1,
      kwLn: kwp1.length
    });

    globalThis.fetch = jest.fn(async (url) => {
      return new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) }
      });
    });

    const req = new Request('https://worker.test/?url=https://upstream.cdn/seg1.png&action=png_ts');
    const res = await worker.fetch(req, {}, {});

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp2t');
    expect(res.headers.get('Content-Length')).toBe(String(ts.length));
    expect(res.headers.get('Content-Range')).toBeNull();
    expect(res.headers.get('Accept-Ranges')).toBeNull();

    const bodyBuf = Buffer.from(await res.arrayBuffer());
    expect(bodyBuf).toEqual(ts);
  });

  test('PNG upstream 206 triggers full re-fetch and returns 200 video/mp2t with byte-exact TS', async () => {
    const ts = makeTsPacket(0x77);
    const kwp1 = makeKwp1Payload(ts);
    const { png } = buildSyntheticPng({
      width: 16,
      height: 16,
      colorType: 2,
      payloadData: kwp1,
      kwLn: kwp1.length
    });

    let fetchCount = 0;
    globalThis.fetch = jest.fn(async (url, init) => {
      fetchCount++;
      if (fetchCount === 1) {
        return new Response(png.subarray(0, 100), {
          status: 206,
          headers: {
            'Content-Type': 'image/png',
            'Content-Range': `bytes 42-141/${png.length + 42}`
          }
        });
      } else {
        expect(init.headers.get('Range')).toBeNull();
        return new Response(png, {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) }
        });
      }
    });

    const req = new Request('https://worker.test/?url=https://upstream.cdn/seg1.png&action=png_ts', {
      headers: { 'Range': 'bytes=0-100' }
    });
    const res = await worker.fetch(req, {}, {});

    expect(fetchCount).toBe(2);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('video/mp2t');
    expect(res.headers.get('Content-Length')).toBe(String(ts.length));
    expect(res.headers.get('Content-Range')).toBeNull();
    const bodyBuf = Buffer.from(await res.arrayBuffer());
    expect(bodyBuf).toEqual(ts);
  });

  test('non-PNG .image remains byte-exact with 42-byte WebP stripping for 200, 206 and HEAD', async () => {
    const rawTs = Buffer.concat([makeTsPacket(0x12), makeTsPacket(0x34)]);
    const fakeWebpHeader = Buffer.alloc(42, 0x99);
    const cloakedFile = Buffer.concat([fakeWebpHeader, rawTs]);

    // 1. Full GET (200)
    globalThis.fetch = jest.fn(async () => {
      return new Response(cloakedFile, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(cloakedFile.length) }
      });
    });

    const req200 = new Request('https://worker.test/?url=https://upstream.cdn/chunk.image');
    const res200 = await worker.fetch(req200, {}, {});
    expect(res200.status).toBe(200);
    expect(res200.headers.get('Content-Length')).toBe(String(rawTs.length));
    const body200 = Buffer.from(await res200.arrayBuffer());
    expect(body200).toEqual(rawTs);

    // 2. HEAD request
    const reqHead = new Request('https://worker.test/?url=https://upstream.cdn/chunk.image', { method: 'HEAD' });
    const resHead = await worker.fetch(reqHead, {}, {});
    expect(resHead.status).toBe(200);
    expect(resHead.headers.get('Content-Length')).toBe(String(rawTs.length));
  });

  test('benchmark endpoints enforce authentication, POST-only, and 10MB limits', async () => {
    const rawTs = Buffer.concat([makeTsPacket(0x55), makeTsPacket(0x66)]);
    const { png } = buildSyntheticPng({
      width: 47,
      height: 8,
      bpp: 3,
      payloadData: rawTs,
      filterType: 0,
      useStoredDeflate: true
    });

    const envWithSecret = { BENCHMARK_TOKEN: 'test-secret-token-123' };

    // 1. Unauthenticated request -> 403 Forbidden
    const reqUnauth = new Request('https://worker.test/?action=bench_decode', {
      method: 'POST',
      body: png
    });
    const resUnauth = await worker.fetch(reqUnauth, envWithSecret, {});
    expect(resUnauth.status).toBe(403);

    // 2. Missing secret in env -> 403 Forbidden even with header
    const resNoEnvSecret = await worker.fetch(reqUnauth, {}, {});
    expect(resNoEnvSecret.status).toBe(403);

    // 3. GET method -> 405 Method Not Allowed
    const reqGet = new Request('https://worker.test/?action=bench_decode', {
      method: 'GET',
      headers: { 'x-bench-token': 'test-secret-token-123' }
    });
    const resGet = await worker.fetch(reqGet, envWithSecret, {});
    expect(resGet.status).toBe(405);

    // 4. Content-Length > 10MB -> 413 Payload Too Large
    const reqOversize = new Request('https://worker.test/?action=bench_decode', {
      method: 'POST',
      headers: {
        'x-bench-token': 'test-secret-token-123',
        'content-length': String(11 * 1024 * 1024)
      },
      body: png
    });
    const resOversize = await worker.fetch(reqOversize, envWithSecret, {});
    expect(resOversize.status).toBe(413);

    // 5. Authenticated bench_relay
    const reqRelay = new Request('https://worker.test/?action=bench_relay', {
      method: 'POST',
      headers: { 'x-bench-token': 'test-secret-token-123' },
      body: png
    });
    const resRelay = await worker.fetch(reqRelay, envWithSecret, {});
    expect(resRelay.status).toBe(200);
    expect(resRelay.headers.get('x-bytes-count')).toBe(String(png.length));
    expect(resRelay.headers.has('x-relay-time-ms')).toBe(false);
    expect(resRelay.headers.has('server-timing')).toBe(false);
    const relayBody = Buffer.from(await resRelay.arrayBuffer());
    expect(relayBody).toEqual(png);

    // 6. Authenticated bench_inflate
    const reqInflate = new Request('https://worker.test/?action=bench_inflate', {
      method: 'POST',
      headers: { 'x-bench-token': 'test-secret-token-123' },
      body: png
    });
    const resInflate = await worker.fetch(reqInflate, envWithSecret, {});
    expect(resInflate.status).toBe(200);
    expect(resInflate.headers.has('x-inflate-time-ms')).toBe(false);
    expect(resInflate.headers.has('server-timing')).toBe(false);
    const inflateJson = await resInflate.json();
    expect(inflateJson.inflatedBytes).toBe(8 * (47 * 3 + 1));
    expect(inflateJson.isStored).toBe(true);

    // 7. Authenticated bench_decode
    const reqDecode = new Request('https://worker.test/?action=bench_decode', {
      method: 'POST',
      headers: { 'x-bench-token': 'test-secret-token-123' },
      body: png
    });
    const resDecode = await worker.fetch(reqDecode, envWithSecret, {});
    expect(resDecode.status).toBe(200);
    expect(resDecode.headers.get('Content-Type')).toBe('video/mp2t');
    expect(resDecode.headers.has('x-decode-time-ms')).toBe(false);
    expect(resDecode.headers.has('server-timing')).toBe(false);
    const decodeBody = Buffer.from(await resDecode.arrayBuffer());
    expect(decodeBody).toEqual(rawTs);
  });
});
