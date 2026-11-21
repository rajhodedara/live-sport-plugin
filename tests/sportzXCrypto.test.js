'use strict';

const { decodeV3, encodeV3, rol32, sxrQr } = require('../src/resolver/sportzx/SportzXCrypto');

describe('SportzXCrypto', () => {
  it('throws on invalid, empty, or null payload', () => {
    expect(() => decodeV3('')).toThrow('Invalid or empty payload');
    expect(() => decodeV3(null)).toThrow('Invalid or empty payload');
    expect(() => decodeV3(undefined)).toThrow('Invalid or empty payload');
  });

  it('throws on payload without 0x03 version prefix', () => {
    // Prefix 0x02 (v2 protocol) or 0x00
    const v2Payload = Buffer.from('\x02some_old_payload').toString('base64');
    expect(() => decodeV3(v2Payload)).toThrow(/Invalid protocol version/i);
  });

  it('correctly executes rol32 bit rotation', () => {
    expect(rol32(0x12345678, 8)).toBe(0x34567812);
    expect(rol32(0x80000000, 1)).toBe(0x00000001);
  });

  it('correctly round-trips synthetic v3 payloads', () => {
    const sampleEvents = [
      {
        id: '50043',
        eventName: 'Charlotte Hornets vs Atlanta Hawks',
        category: 'basketball',
        channels: [
          {
            cat: 'NBA PASS FHD',
            formatsNew: [
              {
                title: '1080p',
                streamUrl: 'https://fernfiber.s3.ca-central-1.amazonaws.com/hornets.m3u8'
              }
            ]
          }
        ]
      }
    ];

    const encoded = encodeV3(sampleEvents);
    expect(typeof encoded).toBe('string');
    
    // Verify first byte of base64 decoded buffer is 0x03
    const raw = Buffer.from(encoded, 'base64');
    expect(raw[0]).toBe(0x03);

    const decoded = decodeV3(encoded);
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded.length).toBe(1);
    expect(decoded[0].id).toBe('50043');
    expect(decoded[0].eventName).toBe('Charlotte Hornets vs Atlanta Hawks');
    expect(decoded[0].channels[0].formatsNew[0].streamUrl).toContain('fernfiber.s3.ca-central-1.amazonaws.com');
  });

  it('handles URL-safe base64 strings (- and _ characters without padding)', () => {
    const sample = [{ id: '99', eventName: 'URL Safe Test' }];
    const standardB64 = encodeV3(sample);
    const urlSafe = standardB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const decoded = decodeV3(urlSafe);
    expect(decoded).toEqual(sample);
  });
});
