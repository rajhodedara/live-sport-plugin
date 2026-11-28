'use strict';

// scripts/diagnostics/png-deflate-census.js
// Bounds-checked DEFLATE block inspector and PNG scanline filter census tool.

const fs = require('fs');
const path = require('path');

// Length base and extra bits tables (RFC 1951)
const LENGTH_CODES = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
];
const LENGTH_EXTRA_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
];

// Distance base and extra bits tables (RFC 1951)
const DISTANCE_CODES = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577
];
const DISTANCE_EXTRA_BITS = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13
];

const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
];

class BitReader {
  constructor(buf, byteOffset = 0) {
    this.buf = buf;
    this.byteOffset = byteOffset;
    this.bitBuffer = 0;
    this.bitsInBuffer = 0;
  }

  ensureBits(n) {
    while (this.bitsInBuffer < n) {
      if (this.byteOffset >= this.buf.length) {
        throw new Error(`Premature end of DEFLATE stream at byte offset ${this.byteOffset}`);
      }
      this.bitBuffer |= (this.buf[this.byteOffset++] << this.bitsInBuffer);
      this.bitsInBuffer += 8;
    }
  }

  readBits(n) {
    if (n === 0) return 0;
    this.ensureBits(n);
    const val = this.bitBuffer & ((1 << n) - 1);
    this.bitBuffer >>>= n;
    this.bitsInBuffer -= n;
    return val;
  }

  peekBits(n) {
    if (n === 0) return 0;
    this.ensureBits(n);
    return this.bitBuffer & ((1 << n) - 1);
  }

  dropBits(n) {
    this.bitBuffer >>>= n;
    this.bitsInBuffer -= n;
  }

  alignToByte() {
    this.bitBuffer = 0;
    this.bitsInBuffer = 0;
  }

  readBytes(n) {
    this.alignToByte();
    if (this.byteOffset + n > this.buf.length) {
      throw new Error(`Cannot read ${n} bytes: buffer has only ${this.buf.length - this.byteOffset} left`);
    }
    const slice = this.buf.subarray(this.byteOffset, this.byteOffset + n);
    this.byteOffset += n;
    return slice;
  }
}

class HuffmanTree {
  constructor(lengths) {
    const maxLen = Math.max(...lengths, 0);
    if (maxLen === 0) {
      this.table = new Int32Array(1).fill(-1);
      this.maxLen = 0;
      return;
    }

    const blCount = new Int32Array(maxLen + 1);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] > 0) blCount[lengths[i]]++;
    }

    const nextCode = new Int32Array(maxLen + 1);
    let code = 0;
    blCount[0] = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }

    // Build lookup table using prefix lookup
    // For fast decoding, we can use a direct table up to maxLen (maxLen <= 15 for RFC 1951)
    this.maxLen = maxLen;
    this.codes = [];
    for (let i = 0; i < lengths.length; i++) {
      const len = lengths[i];
      if (len > 0) {
        const c = nextCode[len]++;
        this.codes.push({ sym: i, len, code: c });
      }
    }

    // Sort by code length for canonical search or table
    this.lookupTable = new Int32Array(1 << maxLen).fill(-1);
    this.lenTable = new Uint8Array(1 << maxLen);
    for (const item of this.codes) {
      // Reverse bits for LSB-first reading
      let rev = 0;
      for (let b = 0; b < item.len; b++) {
        rev = (rev << 1) | ((item.code >> b) & 1);
      }
      const fillBits = maxLen - item.len;
      const fillCount = 1 << fillBits;
      for (let f = 0; f < fillCount; f++) {
        const idx = rev | (f << item.len);
        this.lookupTable[idx] = item.sym;
        this.lenTable[idx] = item.len;
      }
    }
  }

  decode(reader) {
    if (this.maxLen === 0) throw new Error('Empty Huffman tree');
    reader.ensureBits(this.maxLen);
    const bits = reader.peekBits(this.maxLen);
    const sym = this.lookupTable[bits];
    const len = this.lenTable[bits];
    if (sym === -1 || len === 0) {
      throw new Error(`Invalid Huffman symbol encountered for bit pattern 0x${bits.toString(16)}`);
    }
    reader.dropBits(len);
    return sym;
  }
}

// Generate static fixed Huffman trees (RFC 1951 section 3.2.6)
let fixedLitTree = null;
let fixedDistTree = null;
function getFixedTrees() {
  if (!fixedLitTree) {
    const litLens = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) litLens[i] = 8;
    for (let i = 144; i <= 255; i++) litLens[i] = 9;
    for (let i = 256; i <= 279; i++) litLens[i] = 7;
    for (let i = 280; i <= 287; i++) litLens[i] = 8;
    fixedLitTree = new HuffmanTree(litLens);

    const distLens = new Uint8Array(32);
    for (let i = 0; i < 32; i++) distLens[i] = 5;
    fixedDistTree = new HuffmanTree(distLens);
  }
  return { litTree: fixedLitTree, distTree: fixedDistTree };
}

function decodeDynamicTrees(reader) {
  const hlit = reader.readBits(5) + 257;
  const hdist = reader.readBits(5) + 1;
  const hclen = reader.readBits(4) + 4;

  const clLens = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) {
    clLens[CODE_LENGTH_ORDER[i]] = reader.readBits(3);
  }
  const clTree = new HuffmanTree(clLens);

  const totalCodes = hlit + hdist;
  const codeLens = new Uint8Array(totalCodes);
  let idx = 0;
  while (idx < totalCodes) {
    const sym = clTree.decode(reader);
    if (sym < 16) {
      codeLens[idx++] = sym;
    } else if (sym === 16) {
      if (idx === 0) throw new Error('Repeat previous length with no previous code');
      const prev = codeLens[idx - 1];
      const repeat = reader.readBits(2) + 3;
      if (idx + repeat > totalCodes) throw new Error('Code length repeat exceeds total codes');
      for (let r = 0; r < repeat; r++) codeLens[idx++] = prev;
    } else if (sym === 17) {
      const repeat = reader.readBits(3) + 3;
      if (idx + repeat > totalCodes) throw new Error('Zero repeat exceeds total codes');
      for (let r = 0; r < repeat; r++) codeLens[idx++] = 0;
    } else if (sym === 18) {
      const repeat = reader.readBits(7) + 11;
      if (idx + repeat > totalCodes) throw new Error('Zero repeat exceeds total codes');
      for (let r = 0; r < repeat; r++) codeLens[idx++] = 0;
    } else {
      throw new Error(`Invalid code length symbol: ${sym}`);
    }
  }

  const litLens = codeLens.subarray(0, hlit);
  const distLens = codeLens.subarray(hlit);

  return {
    litTree: new HuffmanTree(litLens),
    distTree: new HuffmanTree(distLens)
  };
}

function inspectPng(pngBytes) {
  const u8 = new Uint8Array(pngBytes);
  if (u8.length < 8 ||
      u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47 ||
      u8[4] !== 0x0d || u8[5] !== 0x0a || u8[6] !== 0x1a || u8[7] !== 0x0a) {
    throw new Error('Not a valid PNG file (invalid signature)');
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let kwLn = -1;
  const idatChunks = [];
  let totalIdatBytes = 0;

  while (pos + 12 <= u8.length) {
    const len = ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0;
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > u8.length) {
      throw new Error(`Truncated PNG chunk ${type} at offset ${pos}`);
    }

    if (type === 'IHDR') {
      width = ((u8[dataStart] << 24) | (u8[dataStart + 1] << 16) | (u8[dataStart + 2] << 8) | u8[dataStart + 3]) >>> 0;
      height = ((u8[dataStart + 4] << 24) | (u8[dataStart + 5] << 16) | (u8[dataStart + 6] << 8) | u8[dataStart + 7]) >>> 0;
      bitDepth = u8[dataStart + 8];
      colorType = u8[dataStart + 9];
      interlace = u8[dataStart + 12];
    } else if (type === 'kwLn' && len === 4) {
      kwLn = ((u8[dataStart] << 24) | (u8[dataStart + 1] << 16) | (u8[dataStart + 2] << 8) | u8[dataStart + 3]) >>> 0;
    } else if (type === 'IDAT') {
      idatChunks.push(u8.subarray(dataStart, dataEnd));
      totalIdatBytes += len;
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions: ${width}x${height}`);
  }
  const bppMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const bpp = bppMap[colorType];
  if (!bpp) throw new Error(`Unsupported colorType: ${colorType}`);

  const stride = width * bpp;
  const rawScanlineBytes = height * (stride + 1);

  // Concatenate IDAT data
  const zlibData = new Uint8Array(totalIdatBytes);
  let cOff = 0;
  for (const chunk of idatChunks) {
    zlibData.set(chunk, cOff);
    cOff += chunk.byteLength;
  }

  if (zlibData.length < 6) {
    throw new Error('Truncated zlib stream (less than 6 bytes)');
  }

  // Parse zlib header (RFC 1950)
  const cmf = zlibData[0];
  const flg = zlibData[1];
  if (((cmf << 8) | flg) % 31 !== 0) {
    throw new Error(`Invalid zlib header check (CMF=0x${cmf.toString(16)}, FLG=0x${flg.toString(16)})`);
  }
  if ((cmf & 0x0f) !== 8) {
    throw new Error(`Unsupported compression method ${cmf & 0x0f} (only 8=DEFLATE supported)`);
  }
  let zlibHeaderSize = 2;
  if (flg & 0x20) { // FDICT
    zlibHeaderSize += 4;
  }

  const reader = new BitReader(zlibData, zlibHeaderSize);

  // DEFLATE Block census
  const blockCounts = { 0: 0, 1: 0, 2: 0 };
  const inflatedBytes = { 0: 0, 1: 0, 2: 0 };
  const blocks = [];

  // Allocate raw output buffer
  const rawOutput = new Uint8Array(rawScanlineBytes);
  let outPos = 0;

  let bfinal = 0;
  while (!bfinal) {
    bfinal = reader.readBits(1);
    const btype = reader.readBits(2);

    if (btype === 3) {
      throw new Error('Reserved DEFLATE block type 3 encountered');
    }

    const blockStartPos = outPos;
    blockCounts[btype]++;

    if (btype === 0) {
      // Stored block
      reader.alignToByte();
      if (reader.byteOffset + 4 > zlibData.length) {
        throw new Error('Truncated stored block header');
      }
      const len = zlibData[reader.byteOffset] | (zlibData[reader.byteOffset + 1] << 8);
      const nlen = zlibData[reader.byteOffset + 2] | (zlibData[reader.byteOffset + 3] << 8);
      reader.byteOffset += 4;

      if ((len ^ 0xffff) !== nlen) {
        throw new Error(`Invalid stored block LEN/NLEN mismatch: len=${len}, nlen=${nlen}`);
      }

      const storedBytes = reader.readBytes(len);
      if (outPos + len > rawScanlineBytes) {
        throw new Error(`Stored block inflated bytes (${outPos + len}) exceeds rawScanlineBytes (${rawScanlineBytes})`);
      }
      rawOutput.set(storedBytes, outPos);
      outPos += len;
      inflatedBytes[0] += len;

      blocks.push({
        type: 0,
        name: 'stored',
        bfinal: bfinal === 1,
        inflatedBytes: len
      });
    } else {
      // Huffman block (1=fixed, 2=dynamic)
      let litTree, distTree;
      if (btype === 1) {
        const trees = getFixedTrees();
        litTree = trees.litTree;
        distTree = trees.distTree;
      } else {
        const trees = decodeDynamicTrees(reader);
        litTree = trees.litTree;
        distTree = trees.distTree;
      }

      let blockInflated = 0;
      while (true) {
        const sym = litTree.decode(reader);
        if (sym === 256) {
          // End of block
          break;
        }

        if (sym < 256) {
          if (outPos >= rawScanlineBytes) {
            throw new Error(`Inflated bytes exceed expected rawScanlineBytes (${rawScanlineBytes})`);
          }
          rawOutput[outPos++] = sym;
          blockInflated++;
        } else {
          // Length-distance back reference
          const lenIdx = sym - 257;
          if (lenIdx >= LENGTH_CODES.length) {
            throw new Error(`Invalid length code symbol: ${sym}`);
          }
          const baseLen = LENGTH_CODES[lenIdx];
          const extraBits = LENGTH_EXTRA_BITS[lenIdx];
          const matchLen = baseLen + reader.readBits(extraBits);

          const distSym = distTree.decode(reader);
          if (distSym >= DISTANCE_CODES.length) {
            throw new Error(`Invalid distance symbol: ${distSym}`);
          }
          const baseDist = DISTANCE_CODES[distSym];
          const distExtraBits = DISTANCE_EXTRA_BITS[distSym];
          const matchDist = baseDist + reader.readBits(distExtraBits);

          if (matchDist > outPos) {
            throw new Error(`Back-reference distance ${matchDist} exceeds available output ${outPos}`);
          }

          if (outPos + matchLen > rawScanlineBytes) {
            throw new Error(`Match copy (${outPos + matchLen}) exceeds rawScanlineBytes (${rawScanlineBytes})`);
          }

          let copySrc = outPos - matchDist;
          for (let m = 0; m < matchLen; m++) {
            rawOutput[outPos++] = rawOutput[copySrc++];
          }
          blockInflated += matchLen;
        }
      }

      inflatedBytes[btype] += blockInflated;
      blocks.push({
        type: btype,
        name: btype === 1 ? 'fixed' : 'dynamic',
        bfinal: bfinal === 1,
        inflatedBytes: blockInflated
      });
    }
  }

  if (outPos !== rawScanlineBytes) {
    throw new Error(`Total inflated bytes (${outPos}) does not match expected rawScanlineBytes (${rawScanlineBytes})`);
  }

  // Count PNG filter types per scanline
  const filterCounts = [0, 0, 0, 0, 0];
  const rowStride = stride + 1;
  for (let y = 0; y < height; y++) {
    const ft = rawOutput[y * rowStride];
    if (ft > 4) {
      throw new Error(`Invalid filter type ${ft} at row ${y}`);
    }
    filterCounts[ft]++;
  }

  return {
    width,
    height,
    bitDepth,
    colorType,
    bpp,
    compressedIdatBytes: totalIdatBytes,
    rawScanlineBytes,
    kwLn,
    blocks,
    blockCounts: {
      0: blockCounts[0],
      1: blockCounts[1],
      2: blockCounts[2],
      stored: blockCounts[0],
      fixed: blockCounts[1],
      dynamic: blockCounts[2]
    },
    inflatedBytes: {
      0: inflatedBytes[0],
      1: inflatedBytes[1],
      2: inflatedBytes[2],
      stored: inflatedBytes[0],
      fixed: inflatedBytes[1],
      dynamic: inflatedBytes[2]
    },
    filterCounts: {
      0: filterCounts[0],
      1: filterCounts[1],
      2: filterCounts[2],
      3: filterCounts[3],
      4: filterCounts[4],
      none: filterCounts[0],
      sub: filterCounts[1],
      up: filterCounts[2],
      average: filterCounts[3],
      paeth: filterCounts[4]
    },
    filterCountsArray: filterCounts
  };
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node png-deflate-census.js <file1.png> [file2.png ...]');
    process.exit(1);
  }

  for (const filePath of args) {
    const fullPath = path.resolve(filePath);
    try {
      const fileBuf = fs.readFileSync(fullPath);
      const result = inspectPng(fileBuf);
      console.log(JSON.stringify({
        file: path.basename(fullPath),
        ...result
      }, null, 2));
    } catch (err) {
      console.error(JSON.stringify({
        file: path.basename(fullPath),
        error: err.message
      }, null, 2));
    }
  }
}

module.exports = {
  inspectPng
};
