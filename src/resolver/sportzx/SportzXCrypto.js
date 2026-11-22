'use strict';

const crypto = require('crypto');

const VERSION_V3 = 0x03;
const VERSION_V4 = 0x04;
const CERT_HASH_HEX = '1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b';
const CERT_HASH_BYTES = Buffer.from(CERT_HASH_HEX, 'hex');
const V3_PEPPER_HEX = 'b1657de309d6e790607a5c4ee7d1af4853f571857dc965e65cb56743923a4579';
const V3_PEPPER_BYTES = Buffer.from(V3_PEPPER_HEX, 'hex');
const V3_SXR_LABEL = Buffer.from('SXR3/kdf', 'utf8');

const SXR_CONSTS = Object.freeze([1398297139, -1640531527, 2101127200, -1028477379]);
const STATE_CONSTANTS = Object.freeze([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

// Fallback2 AES-128-CBC keys
const FALLBACK2_KEY = Buffer.from('6ayJ7jo@ao#pxVc%', 'utf8');
const FALLBACK2_IV = Buffer.from('HsjJTCA7jJztpL2w', 'utf8');

function rol32(value, bits) {
  const shift = bits & 31;
  if (shift === 0) return value >>> 0;
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function sxrQr(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) | 0;
  state[d] = rol32(state[d] ^ state[a], 13);
  state[c] = (state[c] + state[d]) | 0;
  state[b] = rol32(state[b] ^ state[c], 17);
  state[a] = (state[a] + state[b]) | 0;
  state[d] = rol32(state[d] ^ state[a], 9);
  state[c] = (state[c] + state[d]) | 0;
  state[b] = rol32(state[b] ^ state[c], 25);
}

function sxrPermute(state) {
  for (let round = 0; round < 10; round += 1) {
    sxrQr(state, 0, 4, 8, 12);
    sxrQr(state, 1, 5, 9, 13);
    sxrQr(state, 2, 6, 10, 14);
    sxrQr(state, 3, 7, 11, 15);
    sxrQr(state, 0, 5, 10, 15);
    sxrQr(state, 1, 6, 11, 12);
    sxrQr(state, 2, 7, 8, 13);
    sxrQr(state, 3, 4, 9, 14);
  }
  return state;
}

class SxrSponge {
  constructor() {
    this.state = new Int32Array(16);
    for (let index = 0; index < 16; index += 1) {
      this.state[index] = ((index + 1) * -1640531527) | 0;
    }
    this.buf = Buffer.alloc(32);
    this.pos = 0;
  }

  absorb(bytes, len = bytes.length, off = 0) {
    for (let index = 0; index < len; index += 1) {
      this.buf[this.pos++] = bytes[off + index];
      if (this.pos === 32) {
        for (let word = 0; word < 8; word += 1) {
          this.state[word] ^= this.buf.readInt32LE(word * 4);
        }
        sxrPermute(this.state);
        this.pos = 0;
      }
    }
  }

  final() {
    this.buf[this.pos++] = 0x80;
    while (this.pos < 32) this.buf[this.pos++] = 0x00;
    for (let word = 0; word < 8; word += 1) {
      this.state[word] ^= this.buf.readInt32LE(word * 4);
    }
    sxrPermute(this.state);
    const output = Buffer.alloc(32);
    for (let word = 0; word < 8; word += 1) {
      output.writeInt32LE(this.state[word], word * 4);
    }
    return output;
  }
}

function sxrPrf(data) {
  const sp = new SxrSponge();
  sp.absorb(data);
  return sp.final();
}

function spAbsorb(state, input) {
  const bytes = Buffer.from(input);
  for (let offset = 0; offset < bytes.length; offset += 48) {
    const length = Math.min(48, bytes.length - offset);
    for (let index = 0; index < length; index += 1) {
      state[index >>> 2] = (
        state[index >>> 2] ^ (bytes[offset + index] << ((index & 3) * 8))
      ) >>> 0;
    }
  }
  return state;
}

function normalizeBase64(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Invalid or empty payload');
  const compact = value.trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error('Malformed base64 payload');
  }
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  return `${standard}${'='.repeat((4 - (standard.length % 4)) % 4)}`;
}

function toBuffer(base64Payload) {
  const decoded = Buffer.from(normalizeBase64(base64Payload), 'base64');
  if (decoded.length === 0) throw new Error('Invalid or empty payload');
  return decoded;
}

/**
 * Decrypt Dalvik SXR Sponge payload (versions 0x03 and 0x04)
 */
function decodeSxr(base64Payload) {
  const raw = toBuffer(base64Payload);
  const version = raw[0];
  if (version !== VERSION_V3 && version !== VERSION_V4) {
    const received = version === undefined ? 'missing' : `0x${version.toString(16).padStart(2, '0')}`;
    throw new Error(`Invalid protocol version: expected 0x03, received ${received}`);
  }
  if (raw.length < 45) throw new Error('Malformed payload data');

  const salt = raw.subarray(1, 17);
  const counterWords = [raw.readInt32LE(17), raw.readInt32LE(21), raw.readInt32LE(25)];
  const ct = raw.subarray(29, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);

  const kdfBuffer = Buffer.concat([V3_SXR_LABEL, CERT_HASH_BYTES, V3_PEPPER_BYTES, salt]);
  const seed = sxrPrf(kdfBuffer);
  const encKey = sxrPrf(Buffer.concat([seed, Buffer.from([1])]));
  const macKey = sxrPrf(Buffer.concat([seed, Buffer.from([2])]));

  // Verify HMAC tag
  const sp = new SxrSponge();
  sp.absorb(macKey);
  sp.absorb(raw.subarray(0, 29));
  sp.absorb(ct);
  sp.absorb(macKey);
  const calculatedTag = sp.final().subarray(0, 16);

  if (!calculatedTag.equals(tag)) {
    throw new Error('HMAC tag mismatch — wrong cert_hash or tampered payload');
  }

  // Generate keystream and decrypt ciphertext
  const streamState = [];
  for (let index = 0; index < 8; index += 1) {
    streamState.push(encKey.readInt32LE(index * 4));
  }

  const plaintext = Buffer.alloc(ct.length);
  const block = Buffer.alloc(64);
  let offset = 0;
  let counter = 0;

  while (offset < ct.length) {
    const state = new Int32Array(16);
    for (let index = 0; index < 4; index += 1) state[index] = SXR_CONSTS[index];
    for (let index = 0; index < 8; index += 1) state[4 + index] = streamState[index];
    state[12] = counter;
    for (let index = 0; index < 3; index += 1) state[13 + index] = counterWords[index];

    const working = new Int32Array(state);
    sxrPermute(working);

    for (let index = 0; index < 16; index += 1) {
      block.writeInt32LE((working[index] + state[index]) | 0, index * 4);
    }

    const chunk = Math.min(64, ct.length - offset);
    for (let index = 0; index < chunk; index += 1) {
      plaintext[offset + index] = ct[offset + index] ^ block[index];
    }
    offset += chunk;
    counter += 1;
  }

  const text = plaintext.toString('utf8').replace(/[\x00-\x20]+$/g, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`SportzX decryption did not produce valid JSON: ${error.message}`);
  }
}

/**
 * Decrypt fallback channels (*e.json) encrypted via AES-128-CBC
 */
function decryptFallback2(base64Payload) {
  const raw = Buffer.from(normalizeBase64(base64Payload), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', FALLBACK2_KEY, FALLBACK2_IV);
  const decrypted = Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted);
}

/**
 * Universal payload decryptor: tries SXR (v3/v4) -> Fallback2 (AES-128-CBC)
 */
function decode(base64Payload) {
  try {
    return decodeSxr(base64Payload);
  } catch (err) {
    try {
      return decryptFallback2(base64Payload);
    } catch {
      throw err;
    }
  }
}

/**
 * Authentic SXR Sponge encoder for testing and round-trip verification
 */
function encodeV3(value, version = VERSION_V3) {
  const jsonStr = typeof value === 'string' ? value : JSON.stringify(value);
  const pt = Buffer.from(jsonStr, 'utf8');

  const salt = Buffer.alloc(16, 0x5a);
  const counterWords = [1, 2, 3];
  const header = Buffer.alloc(29);
  header[0] = version;
  salt.copy(header, 1);
  header.writeInt32LE(counterWords[0], 17);
  header.writeInt32LE(counterWords[1], 21);
  header.writeInt32LE(counterWords[2], 25);

  const kdfBuffer = Buffer.concat([V3_SXR_LABEL, CERT_HASH_BYTES, V3_PEPPER_BYTES, salt]);
  const seed = sxrPrf(kdfBuffer);
  const encKey = sxrPrf(Buffer.concat([seed, Buffer.from([1])]));
  const macKey = sxrPrf(Buffer.concat([seed, Buffer.from([2])]));

  const streamState = [];
  for (let index = 0; index < 8; index += 1) {
    streamState.push(encKey.readInt32LE(index * 4));
  }

  const ct = Buffer.alloc(pt.length);
  const block = Buffer.alloc(64);
  let offset = 0;
  let counter = 0;

  while (offset < pt.length) {
    const state = new Int32Array(16);
    for (let index = 0; index < 4; index += 1) state[index] = SXR_CONSTS[index];
    for (let index = 0; index < 8; index += 1) state[4 + index] = streamState[index];
    state[12] = counter;
    for (let index = 0; index < 3; index += 1) state[13 + index] = counterWords[index];

    const working = new Int32Array(state);
    sxrPermute(working);

    for (let index = 0; index < 16; index += 1) {
      block.writeInt32LE((working[index] + state[index]) | 0, index * 4);
    }

    const chunk = Math.min(64, pt.length - offset);
    for (let index = 0; index < chunk; index += 1) {
      ct[offset + index] = pt[offset + index] ^ block[index];
    }
    offset += chunk;
    counter += 1;
  }

  const sp = new SxrSponge();
  sp.absorb(macKey);
  sp.absorb(header);
  sp.absorb(ct);
  sp.absorb(macKey);
  const tag = sp.final().subarray(0, 16);

  return Buffer.concat([header, ct, tag]).toString('base64');
}

const decodeV3 = decode;
const decodeV4 = decodeSxr;

module.exports = {
  CERT_HASH_HEX,
  CERT_HASH_BYTES,
  V3_PEPPER_HEX,
  V3_PEPPER_BYTES,
  SXR_CONSTS,
  STATE_CONSTANTS,
  decode,
  decodeV3,
  decodeV4,
  decodeSxr,
  decryptFallback2,
  encodeV3,
  normalizeBase64,
  rol32,
  spAbsorb,
  sxrPermute,
  sxrQr,
  SxrSponge,
  sxrPrf
};
