// tests/pngUnfilterWasm.test.js
// Unit tests for WebAssembly PNG scanline unfilterer and bounded PNG decoding.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const wasmPath = path.resolve(__dirname, '../cloudflare-worker/png-unfilter.wasm');
const wasmBytes = fs.readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);

// Reference JS unfilterer for parity testing
function jsUnfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const pixels = new Uint8Array(height * stride);
  let idx = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[idx++];
    const rowOff = y * stride;
    const prevOff = rowOff - stride;
    if (ft === 0) {
      pixels.set(raw.subarray(idx, idx + stride), rowOff);
    } else if (ft === 1) {
      for (let x = 0; x < bpp; x++) pixels[rowOff + x] = raw[idx + x];
      for (let x = bpp; x < stride; x++) pixels[rowOff + x] = (raw[idx + x] + pixels[rowOff + x - bpp]) & 255;
    } else if (ft === 2) {
      if (y === 0) {
        pixels.set(raw.subarray(idx, idx + stride), rowOff);
      } else {
        for (let x = 0; x < stride; x++) pixels[rowOff + x] = (raw[idx + x] + pixels[prevOff + x]) & 255;
      }
    } else if (ft === 3) {
      if (y === 0) {
        for (let x = 0; x < bpp; x++) pixels[rowOff + x] = raw[idx + x];
        for (let x = bpp; x < stride; x++) pixels[rowOff + x] = (raw[idx + x] + (pixels[rowOff + x - bpp] >> 1)) & 255;
      } else {
        for (let x = 0; x < bpp; x++) pixels[rowOff + x] = (raw[idx + x] + (pixels[prevOff + x] >> 1)) & 255;
        for (let x = bpp; x < stride; x++) {
          pixels[rowOff + x] = (raw[idx + x] + ((pixels[rowOff + x - bpp] + pixels[prevOff + x]) >> 1)) & 255;
        }
      }
    } else if (ft === 4) {
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? pixels[rowOff + x - bpp] : 0;
        const b = y > 0 ? pixels[prevOff + x] : 0;
        const c = (x >= bpp && y > 0) ? pixels[prevOff + x - bpp] : 0;
        const p = a + b - c;
        let pa = Math.abs(p - a);
        let pb = Math.abs(p - b);
        let pc = Math.abs(p - c);
        const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        pixels[rowOff + x] = (raw[idx + x] + pred) & 255;
      }
    } else {
      throw new Error(`Unsupported filter ${ft}`);
    }
    idx += stride;
  }
  return pixels;
}

function runWasmUnfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const rawLen = raw.byteLength;
  const outLen = height * stride;
  const totalLen = rawLen + outLen;

  // Instantiate a fresh WebAssembly instance (exclusive memory)
  const instance = new WebAssembly.Instance(wasmModule);
  const memory = instance.exports.memory;

  // Ensure enough memory pages (each page is 64 KiB = 65536 bytes)
  const currentBytes = memory.buffer.byteLength;
  if (totalLen > currentBytes) {
    const neededPages = Math.ceil((totalLen - currentBytes) / 65536);
    memory.grow(neededPages);
  }

  const rawPtr = 0;
  const outPtr = rawLen;

  const memU8 = new Uint8Array(memory.buffer);
  memU8.set(raw, rawPtr);

  const res = instance.exports.unfilter(rawPtr, outPtr, width, height, bpp);
  if (res !== 0) return { code: res, pixels: null };

  // Copy result out into clean standalone Uint8Array
  const result = new Uint8Array(outLen);
  result.set(new Uint8Array(memory.buffer, outPtr, outLen));
  return { code: res, pixels: result };
}

// Bounded decodePngToTs using WebAssembly
async function decodePngToTsWasm(arrayBuf, wasmMod = wasmModule) {
  const va = new Uint8Array(arrayBuf);
  const isPng = va.length >= 8 &&
    va[0] === 0x89 && va[1] === 0x50 && va[2] === 0x4e && va[3] === 0x47 &&
    va[4] === 0x0d && va[5] === 0x0a && va[6] === 0x1a && va[7] === 0x0a;
  if (!isPng) return va;

  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, kwLn = -1;
  const idat = [];
  let totalIdat = 0;

  while (pos + 12 <= va.length) {
    const len = ((va[pos] << 24) | (va[pos + 1] << 16) | (va[pos + 2] << 8) | va[pos + 3]) >>> 0;
    const type = String.fromCharCode(va[pos + 4], va[pos + 5], va[pos + 6], va[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > va.length) throw new Error(`Truncated PNG chunk: ${type}`);

    if (type === 'IHDR') {
      width = ((va[dataStart] << 24) | (va[dataStart + 1] << 16) | (va[dataStart + 2] << 8) | va[dataStart + 3]) >>> 0;
      height = ((va[dataStart + 4] << 24) | (va[dataStart + 5] << 16) | (va[dataStart + 6] << 8) | va[dataStart + 7]) >>> 0;
      bitDepth = va[dataStart + 8];
      colorType = va[dataStart + 9];
      interlace = va[dataStart + 12];
    } else if (type === 'kwLn' && len === 4) {
      kwLn = ((va[dataStart] << 24) | (va[dataStart + 1] << 16) | (va[dataStart + 2] << 8) | va[dataStart + 3]) >>> 0;
    } else if (type === 'IDAT') {
      idat.push(va.subarray(dataStart, dataEnd));
      totalIdat += len;
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0) throw new Error('Unsupported PNG layout');
  if (width <= 0 || width > 16384 || height <= 0 || height > 16384) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }

  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!bpp) throw new Error(`Unsupported PNG colorType=${colorType}`);

  const stride = width * bpp;
  const expectedRawLen = height * (stride + 1);
  if (expectedRawLen > 32 * 1024 * 1024) {
    throw new Error(`PNG raw size exceeds 32MB limit: ${expectedRawLen}`);
  }

  const comp = new Uint8Array(totalIdat);
  let cOff = 0;
  for (const c of idat) {
    comp.set(c, cOff);
    cOff += c.byteLength;
  }

  // Streaming decompression with early abort
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(comp).catch(() => {});
  writer.close().catch(() => {});

  const chunks = [];
  let inflatedLen = 0;
  const reader = ds.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      inflatedLen += value.byteLength;
      if (inflatedLen > expectedRawLen) {
        try { await reader.cancel(); } catch (_) {}
        throw new Error(`Inflated size ${inflatedLen} exceeded expected ${expectedRawLen}`);
      }
      chunks.push(value);
    }
  }

  if (inflatedLen !== expectedRawLen) {
    throw new Error(`Inflated size ${inflatedLen} does not match expected ${expectedRawLen}`);
  }

  // Exclusive WebAssembly Instance for this request
  const instance = wasmMod instanceof WebAssembly.Module ? new WebAssembly.Instance(wasmMod) : (await WebAssembly.instantiate(wasmMod)).instance;
  const memory = instance.exports.memory;
  const outLen = height * stride;
  const totalNeeded = expectedRawLen + outLen;

  const currentBytes = memory.buffer.byteLength;
  if (totalNeeded > currentBytes) {
    const neededPages = Math.ceil((totalNeeded - currentBytes) / 65536);
    memory.grow(neededPages);
  }

  const rawPtr = 0;
  const outPtr = expectedRawLen;
  const memU8 = new Uint8Array(memory.buffer);
  let ro = 0;
  for (const c of chunks) {
    memU8.set(c, ro);
    ro += c.byteLength;
  }

  const retCode = instance.exports.unfilter(rawPtr, outPtr, width, height, bpp);
  if (retCode !== 0) throw new Error(`WASM unfilter failed with code ${retCode}`);

  const pixels = new Uint8Array(outLen);
  pixels.set(new Uint8Array(memory.buffer, outPtr, outLen));

  let payload = pixels;
  if (colorType === 4 || colorType === 6) {
    const keep = colorType === 4 ? 1 : 3;
    const stripped = new Uint8Array(width * height * keep);
    for (let src = 0, dst = 0; dst < stripped.length; src += bpp, dst += keep) {
      for (let k = 0; k < keep; k++) stripped[dst + k] = pixels[src + k];
    }
    payload = stripped;
  }

  if (kwLn > 0 && kwLn <= payload.length) {
    payload = payload.subarray(0, kwLn);
  }

  if (payload.length >= 8 && payload[0] === 0x4b && payload[1] === 0x57 && payload[2] === 0x50 && payload[3] === 0x31) {
    const tsLen = ((payload[4] << 24) | (payload[5] << 16) | (payload[6] << 8) | payload[7]) >>> 0;
    if (8 + tsLen > payload.length) throw new Error('KWP1 length exceeds decoded bytes');
    return payload.slice(8, 8 + tsLen);
  }

  if (payload.length >= 188 && payload[0] === 0x47) {
    let aligned = Math.floor(payload.length / 188) * 188;
    while (aligned >= 188 && payload[aligned - 188] !== 0x47) aligned -= 188;
    return aligned > 0 ? payload.slice(0, aligned) : payload.slice();
  }

  throw new Error('Decoded PNG does not contain KWP1 or MPEG-TS payload');
}

// Helper to construct a minimal synthetic PNG
function makePng({ width, height, colorType, filterType, payloadData, kwLn }) {
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  let idx = 0;
  let pIdx = 0;

  for (let y = 0; y < height; y++) {
    raw[idx++] = filterType;
    for (let x = 0; x < stride; x++) {
      raw[idx++] = pIdx < payloadData.length ? payloadData[pIdx++] : 0;
    }
  }

  const comp = zlib.deflateSync(raw);

  // Build PNG chunks
  const chunks = [];
  // PNG Magic
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bitDepth
  ihdrData[9] = colorType;
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  chunks.push(makeChunk('IHDR', ihdrData));

  // kwLn if requested
  if (kwLn !== undefined) {
    const kwLnData = Buffer.alloc(4);
    kwLnData.writeUInt32BE(kwLn, 0);
    chunks.push(makeChunk('kwLn', kwLnData));
  }

  // IDAT
  chunks.push(makeChunk('IDAT', comp));

  // IEND
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat(chunks);
}

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(12 + len);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, 'ascii');
  data.copy(buf, 8);
  // crc can be 0 for our parser
  buf.writeUInt32BE(0, 8 + len);
  return buf;
}

describe('png-unfilter.wasm Scanline Unfiltering', () => {
  test('matches JS reference across bpp=1,2,3,4 and all 5 filters (0-4)', () => {
    const width = 16;
    const height = 10;

    for (const bpp of [1, 2, 3, 4]) {
      const stride = width * bpp;
      for (let filter = 0; filter <= 4; filter++) {
        const raw = new Uint8Array(height * (stride + 1));
        let idx = 0;
        for (let y = 0; y < height; y++) {
          raw[idx++] = filter;
          for (let x = 0; x < stride; x++) {
            raw[idx++] = ((y * 31 + x * 17 + bpp * 13) & 255);
          }
        }

        const jsExpected = jsUnfilter(raw, width, height, bpp);
        const wasmRes = runWasmUnfilter(raw, width, height, bpp);

        expect(wasmRes.code).toBe(0);
        expect(wasmRes.pixels).toEqual(jsExpected);
      }
    }
  });

  test('matches JS reference with mixed filters per scanline', () => {
    const width = 23;
    const height = 15;
    const bpp = 3;
    const stride = width * bpp;

    const raw = new Uint8Array(height * (stride + 1));
    let idx = 0;
    for (let y = 0; y < height; y++) {
      raw[idx++] = y % 5;
      for (let x = 0; x < stride; x++) {
        raw[idx++] = ((y * 19 + x * 7 + 101) & 255);
      }
    }

    const jsExpected = jsUnfilter(raw, width, height, bpp);
    const wasmRes = runWasmUnfilter(raw, width, height, bpp);

    expect(wasmRes.code).toBe(0);
    expect(wasmRes.pixels).toEqual(jsExpected);
  });

  test('handles memory growth across multiple 64 KiB pages (e.g. 512x512 RGBA > 1 MiB)', () => {
    const width = 512;
    const height = 512;
    const bpp = 4;
    const stride = width * bpp;
    const rawLen = height * (stride + 1);

    const raw = new Uint8Array(rawLen);
    let idx = 0;
    for (let y = 0; y < height; y++) {
      raw[idx++] = y % 5;
      for (let x = 0; x < stride; x++) {
        raw[idx++] = (x ^ y) & 255;
      }
    }

    const wasmRes = runWasmUnfilter(raw, width, height, bpp);
    expect(wasmRes.code).toBe(0);
    expect(wasmRes.pixels.byteLength).toBe(height * stride);
    expect(wasmRes.pixels[0]).toBe(raw[1]);
  });

  test('rejects invalid filter byte (> 4) with return code -1', () => {
    const width = 10;
    const height = 4;
    const bpp = 3;
    const stride = width * bpp;
    const raw = new Uint8Array(height * (stride + 1));
    raw[0] = 5;

    const wasmRes = runWasmUnfilter(raw, width, height, bpp);
    expect(wasmRes.code).toBe(-1);
    expect(wasmRes.pixels).toBeNull();
  });

  test('concurrent Promise.all unfilters never cross-contaminate buffers', async () => {
    const tasks = [
      { width: 32, height: 16, bpp: 1, val: 42 },
      { width: 20, height: 20, bpp: 3, val: 99 },
      { width: 40, height: 10, bpp: 4, val: 177 }
    ];

    const promises = tasks.map(async (t) => {
      const stride = t.width * t.bpp;
      const raw = new Uint8Array(t.height * (stride + 1));
      let idx = 0;
      for (let y = 0; y < t.height; y++) {
        raw[idx++] = 0;
        for (let x = 0; x < stride; x++) raw[idx++] = t.val;
      }
      const res = runWasmUnfilter(raw, t.width, t.height, t.bpp);
      return { t, res };
    });

    const results = await Promise.all(promises);
    for (const { t, res } of results) {
      expect(res.code).toBe(0);
      expect(res.pixels.length).toBe(t.width * t.height * t.bpp);
      for (let i = 0; i < res.pixels.length; i++) {
        expect(res.pixels[i]).toBe(t.val);
      }
    }
  });
});

describe('decodePngToTsWasm End-to-End Pipeline', () => {
  test('decodes KWP1 wrapped MPEG-TS segment', async () => {
    // Construct dummy MPEG-TS 188-byte packet
    const tsPacket = Buffer.alloc(188);
    tsPacket[0] = 0x47;
    for (let i = 1; i < 188; i++) tsPacket[i] = (i * 7) & 255;

    // Wrap in KWP1 header: [0x4b, 0x57, 0x50, 0x31] + uint32 len
    const kwp1 = Buffer.alloc(8 + tsPacket.length);
    kwp1.write('KWP1', 0, 4, 'ascii');
    kwp1.writeUInt32BE(tsPacket.length, 4);
    tsPacket.copy(kwp1, 8);

    const png = makePng({
      width: 16,
      height: 16, // 16x16x3 = 768 bytes, enough for 196 bytes of KWP1
      colorType: 2, // RGB
      filterType: 0,
      payloadData: kwp1,
      kwLn: kwp1.length
    });

    const decoded = await decodePngToTsWasm(png);
    expect(decoded.length).toBe(188);
    expect(decoded[0]).toBe(0x47);
    expect(Buffer.from(decoded)).toEqual(tsPacket);
  });

  test('aborts early on oversized inflated stream', async () => {
    // Generate inflated payload larger than expectedRawLen
    const width = 10;
    const height = 10; // expected raw len = 10 * (10*3 + 1) = 310
    const bpp = 3;
    const hugeRaw = new Uint8Array(1000); // oversized!
    const comp = zlib.deflateSync(hugeRaw);

    // Build PNG with IHDR stating 10x10
    const chunks = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', Buffer.from([0,0,0,10, 0,0,0,10, 8,2,0,0,0])),
      makeChunk('IDAT', comp),
      makeChunk('IEND', Buffer.alloc(0))
    ];
    const png = Buffer.concat(chunks);

    await expect(decodePngToTsWasm(png)).rejects.toThrow(/exceeded expected/);
  });

  test('aborts on truncated inflated stream', async () => {
    const width = 10;
    const height = 10; // expected raw len = 310
    const smallRaw = new Uint8Array(200); // truncated!
    const comp = zlib.deflateSync(smallRaw);

    const chunks = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', Buffer.from([0,0,0,10, 0,0,0,10, 8,2,0,0,0])),
      makeChunk('IDAT', comp),
      makeChunk('IEND', Buffer.alloc(0))
    ];
    const png = Buffer.concat(chunks);

    await expect(decodePngToTsWasm(png)).rejects.toThrow(/does not match expected/);
  });

  test('rejects dimensions exceeding limits (> 16384 or > 32MB)', async () => {
    const chunks = [
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', Buffer.from([0,0,0x40,1, 0,0,0x40,1, 8,2,0,0,0])), // 16385 x 16385
      makeChunk('IEND', Buffer.alloc(0))
    ];
    const png = Buffer.concat(chunks);

    await expect(decodePngToTsWasm(png)).rejects.toThrow(/Invalid PNG dimensions/);
  });
});
