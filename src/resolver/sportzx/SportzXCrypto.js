'use strict';

const VERSION = 0x03;
const CERT_HASH_HEX = '1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b';
const CERT_HASH_BYTES = Buffer.from(CERT_HASH_HEX, 'hex');
const STATE_CONSTANTS = Object.freeze([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

function rol32(value, bits) {
  const shift = bits & 31;
  if (shift === 0) return value >>> 0;
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function sxrQr(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rol32((state[d] ^ state[a]) >>> 0, 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rol32((state[b] ^ state[c]) >>> 0, 12);
  state[a] = (state[a] + state[b]) >>> 0;
  state[d] = rol32((state[d] ^ state[a]) >>> 0, 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rol32((state[b] ^ state[c]) >>> 0, 7);
}

function sxrPermute(state) {
  if (!(state instanceof Uint32Array) || state.length !== 16) {
    throw new TypeError('sxrPermute requires a 16-word Uint32Array');
  }
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

function spAbsorb(state, input) {
  if (!(state instanceof Uint32Array) || state.length !== 16) {
    throw new TypeError('spAbsorb requires a 16-word Uint32Array');
  }
  const bytes = Buffer.from(input);
  for (let offset = 0; offset < bytes.length; offset += 48) {
    const length = Math.min(48, bytes.length - offset);
    for (let index = 0; index < length; index += 1) {
      state[index >>> 2] = (
        state[index >>> 2] ^ (bytes[offset + index] << ((index & 3) * 8))
      ) >>> 0;
    }
    sxrPermute(state);
  }
  return state;
}

function createInitialState() {
  const state = new Uint32Array(16);
  state.set(STATE_CONSTANTS, 0);
  for (let index = 0; index < 8; index += 1) {
    state[4 + index] = CERT_HASH_BYTES.readUInt32LE(index * 4) >>> 0;
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

function cryptBody(body) {
  const state = createInitialState();
  sxrPermute(state);
  const output = Buffer.allocUnsafe(body.length);
  const keyStream = Buffer.allocUnsafe(64);
  for (let offset = 0; offset < body.length; offset += 64) {
    state[12] = (state[12] + 1) >>> 0;
    const working = new Uint32Array(state);
    sxrPermute(working);
    for (let word = 0; word < 16; word += 1) {
      keyStream.writeUInt32LE((working[word] + state[word]) >>> 0, word * 4);
    }
    const length = Math.min(64, body.length - offset);
    for (let index = 0; index < length; index += 1) {
      output[offset + index] = body[offset + index] ^ keyStream[index];
    }
  }
  return output;
}

function decodeV3(base64Payload) {
  const raw = toBuffer(base64Payload);
  if (raw[0] !== VERSION) {
    const received = raw[0] === undefined ? 'missing' : `0x${raw[0].toString(16).padStart(2, '0')}`;
    throw new Error(`Invalid protocol version: expected 0x03, received ${received}`);
  }
  if (raw.length === 1) throw new Error('Malformed payload data');
  const text = cryptBody(raw.subarray(1)).toString('utf8').replace(/[\x00-\x20]+$/g, '');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`SportzX v3 decryption did not produce valid JSON: ${error.message}`);
  }
}

function encodeV3(value) {
  const plaintext = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return Buffer.concat([Buffer.from([VERSION]), cryptBody(plaintext)]).toString('base64');
}

module.exports = {
  CERT_HASH_HEX,
  STATE_CONSTANTS,
  decodeV3,
  encodeV3,
  normalizeBase64,
  rol32,
  spAbsorb,
  sxrPermute,
  sxrQr
};
