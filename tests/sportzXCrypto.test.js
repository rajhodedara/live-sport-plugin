'use strict';

const {
  CERT_HASH_HEX,
  STATE_CONSTANTS,
  decodeV3,
  encodeV3,
  normalizeBase64,
  rol32,
  spAbsorb,
  sxrQr
} = require('../src/resolver/sportzx/SportzXCrypto');

describe('SportzXCrypto', () => {
  const sampleEvents = [{
    id: '50043',
    eventName: 'Charlotte Hornets vs Atlanta Hawks',
    category: 'basketball',
    channels: [{ formatsNew: [{ title: '1080p', streamUrl: 'https://example.test/live.m3u8' }] }]
  }];

  it('pins the APK certificate and Dalvik state constants', () => {
    expect(CERT_HASH_HEX).toBe('1676ec7db4771b0d826d70369b579684b182d2c0133be041bdd55f5d6d79a98b');
    expect(STATE_CONSTANTS).toEqual([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  });

  it('throws on invalid, empty, or malformed base64', () => {
    expect(() => decodeV3('')).toThrow('Invalid or empty payload');
    expect(() => decodeV3(null)).toThrow('Invalid or empty payload');
    expect(() => decodeV3('abcde')).toThrow('Malformed base64 payload');
    expect(() => decodeV3('@@@=')).toThrow('Malformed base64 payload');
  });

  it('rejects payloads without the 0x03 protocol byte', () => {
    const payload = Buffer.from('\x02old-protocol').toString('base64');
    expect(() => decodeV3(payload)).toThrow('expected 0x03, received 0x02');
  });

  it('normalizes URL-safe base64 and missing padding', () => {
    expect(normalizeBase64(' A-_ ')).toBe('A+/=');
    const encoded = encodeV3(sampleEvents).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeV3(encoded)).toEqual(sampleEvents);
  });

  it('round-trips encrypted multi-block payloads', () => {
    const encoded = encodeV3(sampleEvents);
    const raw = Buffer.from(encoded, 'base64');
    expect(raw[0]).toBe(0x03);
    expect(raw.subarray(1).equals(Buffer.from(JSON.stringify(sampleEvents)))).toBe(false);
    expect(decodeV3(encoded)).toEqual(sampleEvents);
  });

  it('executes unsigned rotations, quarter rounds, and partial sponge words', () => {
    expect(rol32(0x12345678, 8)).toBe(0x34567812);
    expect(rol32(0x80000000, 1)).toBe(1);
    const state = new Uint32Array(16);
    sxrQr(state, 0, 1, 2, 3);
    expect([...state]).toHaveLength(16);
    const absorbed = new Uint32Array(16);
    spAbsorb(absorbed, Buffer.from([1, 2, 3]));
    expect([...absorbed].some(value => value !== 0)).toBe(true);
  });
});
