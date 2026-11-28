'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { inspectPng } = require('../scripts/diagnostics/png-deflate-census');

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

function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function makeStoredZlib(raw) {
  const chunks = [];
  chunks.push(Buffer.from([0x78, 0x01])); // CMF, FLG
  let offset = 0;
  while (offset < raw.length) {
    const chunkLen = Math.min(raw.length - offset, 65535);
    const isLast = (offset + chunkLen >= raw.length);
    const bfinal = isLast ? 0x01 : 0x00;
    const header = Buffer.alloc(5);
    header[0] = bfinal; // BFINAL=1/0, BTYPE=00 (stored)
    header.writeUInt16LE(chunkLen, 1);
    header.writeUInt16LE((~chunkLen) & 0xffff, 3);
    chunks.push(header);
    chunks.push(raw.subarray(offset, offset + chunkLen));
    offset += chunkLen;
  }
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(adler32(raw), 0);
  chunks.push(adler);
  return Buffer.concat(chunks);
}

function buildPngWithIdats(width, height, colorType, idatPayloads) {
  const bppMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const chunks = [sig, makeChunk('IHDR', ihdr)];
  for (const payload of idatPayloads) {
    chunks.push(makeChunk('IDAT', payload));
  }
  chunks.push(makeChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

describe('png-deflate-census inspectPng', () => {
  test('accurately parses an all-stored stream (DEFLATE type 0)', () => {
    const width = 8;
    const height = 5;
    const bpp = 3;
    const stride = width * bpp;
    const rawLen = height * (stride + 1);
    const raw = Buffer.alloc(rawLen);

    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = y % 5; // filter types 0, 1, 2, 3, 4
      for (let x = 0; x < stride; x++) {
        raw[y * (stride + 1) + 1 + x] = (y * stride + x) & 255;
      }
    }

    const zlibData = makeStoredZlib(raw);
    const png = buildPngWithIdats(width, height, 2, [zlibData]);

    const result = inspectPng(png);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.colorType).toBe(2);
    expect(result.bpp).toBe(bpp);
    expect(result.compressedIdatBytes).toBe(zlibData.length);
    expect(result.rawScanlineBytes).toBe(rawLen);

    expect(result.blockCounts[0]).toBe(1);
    expect(result.blockCounts[1]).toBe(0);
    expect(result.blockCounts[2]).toBe(0);
    expect(result.inflatedBytes[0]).toBe(rawLen);
    expect(result.inflatedBytes[1]).toBe(0);
    expect(result.inflatedBytes[2]).toBe(0);

    expect(result.filterCounts[0]).toBe(1);
    expect(result.filterCounts[1]).toBe(1);
    expect(result.filterCounts[2]).toBe(1);
    expect(result.filterCounts[3]).toBe(1);
    expect(result.filterCounts[4]).toBe(1);
  });

  test('accurately parses fixed-Huffman stream (DEFLATE type 1) with back-references', () => {
    const width = 16;
    const height = 4;
    const bpp = 1;
    const stride = width * bpp;
    const rawLen = height * (stride + 1);
    const raw = Buffer.alloc(rawLen);

    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = y; // filter types 0, 1, 2, 3
      for (let x = 0; x < stride; x++) {
        raw[y * (stride + 1) + 1 + x] = 65; // repetitive bytes to trigger back-references
      }
    }

    const zlibData = zlib.deflateSync(raw, { strategy: zlib.constants.Z_FIXED });
    const png = buildPngWithIdats(width, height, 0, [zlibData]);

    const result = inspectPng(png);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.rawScanlineBytes).toBe(rawLen);

    expect(result.blockCounts[1]).toBeGreaterThanOrEqual(1);
    expect(result.inflatedBytes[1]).toBe(rawLen);
    expect(result.inflatedBytes[0]).toBe(0);
    expect(result.inflatedBytes[2]).toBe(0);

    expect(result.filterCounts[0]).toBe(1);
    expect(result.filterCounts[1]).toBe(1);
    expect(result.filterCounts[2]).toBe(1);
    expect(result.filterCounts[3]).toBe(1);
    expect(result.filterCounts[4]).toBe(0);
  });

  test('accurately parses dynamic-Huffman stream (DEFLATE type 2) with back-references', () => {
    const width = 64;
    const height = 10;
    const bpp = 3;
    const stride = width * bpp;
    const rawLen = height * (stride + 1);
    const raw = Buffer.alloc(rawLen);

    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 4; // Paeth rows
      for (let x = 0; x < stride; x++) {
        raw[y * (stride + 1) + 1 + x] = (x ^ y * 17) & 255;
      }
    }

    const zlibData = zlib.deflateSync(raw, { level: 9 });
    const png = buildPngWithIdats(width, height, 2, [zlibData]);

    const result = inspectPng(png);
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.rawScanlineBytes).toBe(rawLen);

    expect(result.blockCounts[2]).toBeGreaterThanOrEqual(1);
    expect(result.inflatedBytes[2]).toBe(rawLen);
    expect(result.inflatedBytes[0]).toBe(0);
    expect(result.inflatedBytes[1]).toBe(0);

    expect(result.filterCounts[4]).toBe(10);
  });

  test('handles split IDAT boundaries crossing headers and blocks', () => {
    const width = 20;
    const height = 5;
    const bpp = 3;
    const stride = width * bpp;
    const rawLen = height * (stride + 1);
    const raw = Buffer.alloc(rawLen);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = 0;
      for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = 42;
    }

    const zlibData = zlib.deflateSync(raw);
    // Split into 3 arbitrary chunks
    const p1 = zlibData.subarray(0, 7);
    const p2 = zlibData.subarray(7, 25);
    const p3 = zlibData.subarray(25);

    const png = buildPngWithIdats(width, height, 2, [p1, p2, p3]);

    const result = inspectPng(png);
    expect(result.compressedIdatBytes).toBe(zlibData.length);
    expect(result.rawScanlineBytes).toBe(rawLen);
    const totalInflated = result.inflatedBytes[0] + result.inflatedBytes[1] + result.inflatedBytes[2];
    expect(totalInflated).toBe(rawLen);
  });

  test('rejects truncated IDAT or corrupt DEFLATE stream', () => {
    const width = 20;
    const height = 5;
    const raw = Buffer.alloc(height * (20 * 3 + 1));
    const zlibData = zlib.deflateSync(raw);
    const truncatedZlib = zlibData.subarray(0, zlibData.length - 10); // chop off end

    const png = buildPngWithIdats(width, height, 2, [truncatedZlib]);
    expect(() => inspectPng(png)).toThrow();
  });
});
