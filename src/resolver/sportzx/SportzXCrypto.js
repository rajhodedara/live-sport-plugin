'use strict';

const crypto = require('crypto');

// SHA-256 digest of developer's official APK signing certificate (SportzX TV)
const CERT_HASH_HEX = '1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b';
const CERT_HASH_BYTES = Buffer.from(CERT_HASH_HEX, 'hex');

/**
 * 32-bit left bitwise rotation
 */
function rol32(val, bits) {
  const n = bits % 32;
  return (((val << n) | (val >>> (32 - n))) >>> 0);
}

/**
 * ChaCha20 quarter round (sxrQr)
 */
function sxrQr(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rol32(state[d] ^ state[a], 16);

  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rol32(state[b] ^ state[c], 12);

  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rol32(state[d] ^ state[a], 8);

  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rol32(state[b] ^ state[c], 7);
}

/**
 * ChaCha20 20-round permutation (sxrPermute)
 */
function sxrPermute(state) {
  for (let i = 0; i < 10; i++) {
    // Column round
    sxrQr(state, 0, 4, 8, 12);
    sxrQr(state, 1, 5, 9, 13);
    sxrQr(state, 2, 6, 10, 14);
    sxrQr(state, 3, 7, 11, 15);

    // Diagonal round
    sxrQr(state, 0, 5, 10, 15);
    sxrQr(state, 1, 6, 11, 12);
    sxrQr(state, 2, 7, 8, 13);
    sxrQr(state, 3, 4, 9, 14);
  }
}

/**
 * Sponge absorb step (spAbsorb)
 */
function spAbsorb(state, chunk) {
  const wordsToAbsorb = Math.min(Math.floor(chunk.length / 4), 12);
  for (let i = 0; i < wordsToAbsorb; i++) {
    const word = chunk.readUInt32LE(i * 4);
    state[i] = (state[i] ^ word) >>> 0;
  }
  sxrPermute(state);
}

/**
 * Normalizes URL-safe or standard base64 string to a Buffer
 */
function toBuffer(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  const standard = b64.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = standard.length % 4;
  const padded = pad ? standard + '='.repeat(4 - pad) : standard;
  return Buffer.from(padded, 'base64');
}

/**
 * Decrypts a SportzX v3 protocol payload
 * @param {string} base64Payload - Standard or URL-safe base64 string
 * @returns {Array<object>|object} Parsed JSON data
 */
function decodeV3(base64Payload) {
  if (!base64Payload || typeof base64Payload !== 'string') {
    throw new Error('Invalid or empty payload');
  }

  const raw = toBuffer(base64Payload);
  if (!raw || raw.length === 0) {
    throw new Error('Invalid or empty payload');
  }

  const version = raw[0];
  if (version !== 0x03) {
    throw new Error(`Invalid protocol version: expected 0x03, received 0x${version.toString(16)}`);
  }

  const body = raw.subarray(1);
  if (body.length === 0) {
    throw new Error('Malformed payload data');
  }

  // Fast-path: Check if body is plain UTF-8 JSON (synthetic or pre-unwrapped)
  const firstChar = String.fromCharCode(body[0]);
  if (firstChar === '{' || firstChar === '[') {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch (_) {
      // Fall through to decryption
    }
  }

  // Decrypt using ChaCha20 / Sponge keystream
  // Initialize state with constants and certificate hash
  const state = new Uint32Array(16);
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;

  for (let i = 0; i < 8; i++) {
    state[4 + i] = CERT_HASH_BYTES.readUInt32LE(i * 4);
  }

  state[12] = 0x00000000;
  state[13] = 0x00000000;
  state[14] = 0x00000000;
  state[15] = 0x00000000;

  sxrPermute(state);

  const outBuf = Buffer.alloc(body.length);
  const keystreamBuf = Buffer.alloc(64);

  let offset = 0;
  while (offset < body.length) {
    state[12] = (state[12] + 1) >>> 0;
    const workingState = new Uint32Array(state);
    sxrPermute(workingState);

    for (let i = 0; i < 16; i++) {
      keystreamBuf.writeUInt32LE((workingState[i] + state[i]) >>> 0, i * 4);
    }

    const blockSize = Math.min(64, body.length - offset);
    for (let i = 0; i < blockSize; i++) {
      outBuf[offset + i] = body[offset + i] ^ keystreamBuf[i];
    }
    offset += blockSize;
  }

  const plainText = outBuf.toString('utf8');
  try {
    return JSON.parse(plainText);
  } catch (err) {
    // If decryption yields raw JSON after trimming null bytes or padding
    const trimmed = plainText.replace(/[\x00-\x1f\x7f-\x9f]+$/g, '').trim();
    return JSON.parse(trimmed);
  }
}

/**
 * Encodes data into a synthetic v3 protocol payload (for testing and integration)
 */
function encodeV3(data) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  const bodyBuf = Buffer.from(jsonStr, 'utf8');
  const fullBuf = Buffer.concat([Buffer.from([0x03]), bodyBuf]);
  return fullBuf.toString('base64');
}

module.exports = {
  decodeV3,
  encodeV3,
  rol32,
  sxrQr,
  sxrPermute,
  spAbsorb
};
