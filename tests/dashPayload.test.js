'use strict';

const crypto = require('crypto');
const {
  signPayload, verifyPayload, normalizePayload
} = require('../src/services/DashPayload');

const signer = crypto.createHash('sha256').update('dash-payload-unit-tests').digest('hex');
const otherSigner = crypto.createHash('sha256').update('some-other-signer').digest('hex');

const KEY_HEX = 'ca0b64b84edb4f20eb1e135ff03db4f7';
const KID_HEX = '18e6af4a0daf2a1fdfbdc5b541520c88';

const base = () => ({
  mpdUrl: 'https://otte.live.fly.ww.aiv-cdn.net/fra-nitro/out/v1/ab9d1f/cenc.mpd',
  key: KEY_HEX,
  kid: KID_HEX,
  headers: { 'User-Agent': 'okhttp/4.9.2' }
});

describe('DashPayload signing', () => {
  test('round-trips a payload', () => {
    const signed = signPayload(base(), { signWith: signer });
    const result = verifyPayload(signed, { signWith: signer });

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ mpdUrl: base().mpdUrl, key: KEY_HEX, kid: KID_HEX });
    expect(result.payload.headers['User-Agent']).toBe('okhttp/4.9.2');
  });

  test('is deterministic for the same payload (no random nonce in the token)', () => {
    expect(signPayload(base(), { signWith: signer })).toBe(signPayload(base(), { signWith: signer }));
  });

  test('rejects a tampered payload body', () => {
    const signed = signPayload(base(), { signWith: signer });
    const [body, sig] = signed.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    decoded.mpdUrl = 'http://169.254.169.254/latest/meta-data/';
    const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`;

    expect(verifyPayload(forged, { signWith: signer })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
  });

  test('rejects a token signed by a different key', () => {
    const signed = signPayload(base(), { signWith: otherSigner });
    expect(verifyPayload(signed, { signWith: signer })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
  });

  test('rejects a signature of a different length without throwing', () => {
    const signed = signPayload(base(), { signWith: signer });
    const [body] = signed.split('.');
    // timingSafeEqual throws on length mismatch; a 403 must not become a 500
    expect(() => verifyPayload(`${body}.short`, { signWith: signer })).not.toThrow();
    expect(verifyPayload(`${body}.short`, { signWith: signer })).toMatchObject({ ok: false, code: 'BAD_SIGNATURE' });
  });

  test('rejects an expired token and accepts one that has not expired yet', () => {
    const now = 1_700_000_000_000;
    const expired = signPayload(base(), { signWith: signer, ttlSec: 60, now });
    expect(verifyPayload(expired, { signWith: signer, now: now + 61_000 })).toMatchObject({ ok: false, code: 'EXPIRED' });
    expect(verifyPayload(expired, { signWith: signer, now: now + 30_000 }).ok).toBe(true);
  });

  test('catalogue tokens (no ttl) never expire', () => {
    const catalogue = signPayload(base(), { signWith: signer });
    expect(verifyPayload(catalogue, { signWith: signer, now: Date.now() + 30 * 24 * 3600 * 1000 }).ok).toBe(true);
  });

  test('flags missing, malformed and oversized tokens', () => {
    expect(verifyPayload('', { signWith: signer })).toMatchObject({ ok: false, code: 'MISSING', status: 400 });
    expect(verifyPayload(undefined, { signWith: signer })).toMatchObject({ ok: false, code: 'MISSING' });
    expect(verifyPayload('no-dot-here', { signWith: signer })).toMatchObject({ ok: false, code: 'MALFORMED' });
    expect(verifyPayload(`${'a'.repeat(9000)}.sig`, { signWith: signer }))
      .toMatchObject({ ok: false, code: 'TOKEN_TOO_LARGE', status: 403 });
  });

  test('refuses to sign a payload with an invalid key or mpdUrl', () => {
    expect(() => signPayload({ ...base(), key: 'not-hex' }, { signWith: signer })).toThrow();
    expect(() => signPayload({ ...base(), mpdUrl: 'file:///etc/passwd' }, { signWith: signer })).toThrow();
  });

  test('drops headers outside the allowlist and any CRLF injection', () => {
    const payload = normalizePayload({
      ...base(),
      headers: {
        'User-Agent': 'ua',
        Referer: 'https://ok.example/',
        Cookie: 'session=abc',
        Authorization: 'Bearer x',
        'X-Evil': 'y\r\nHost: internal'
      }
    });

    expect(Object.keys(payload.headers)).toEqual(['User-Agent', 'Referer']);
    expect(payload.headers.Cookie).toBeUndefined();
  });

  test('normalises a dashed KID and rejects a malformed one', () => {
    expect(normalizePayload({ ...base(), kid: '18E6AF4A-0DAF-2A1F-DFBD-C5B541520C88' }).kid).toBe(KID_HEX);
    expect(normalizePayload({ ...base(), kid: 'nope' }).kid).toBe('');
  });
});
