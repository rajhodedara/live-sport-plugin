'use strict';

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { loadAuthConfig } = require('../src/auth/authConfig');
const { AuthStore } = require('../src/auth/AuthStore');
const { AuthService } = require('../src/auth/AuthService');
const { createProviderRegistry } = require('../src/auth/providers');
const { createGoogleProvider } = require('../src/auth/providers/google');
const { createAuthRouter } = require('../src/routes/auth');
const { createDeviceConfigMiddleware } = require('../src/auth/deviceConfigMiddleware');
const authCrypto = require('../src/auth/AuthCrypto');

const PEPPER = 'p'.repeat(40);
const KEY = 'k'.repeat(40);
const ENV = { AUTH_TOKEN_PEPPER: PEPPER, AUTH_ENCRYPTION_KEY: KEY, AUTH_GOOGLE_CLIENT_ID: 'cid', AUTH_GOOGLE_CLIENT_SECRET: 'sec' };

function makeIdToken(claims, privateKey, kid = 'k1') {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url');
  const b = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), privateKey).toString('base64url');
  return `${h}.${b}.${sig}`;
}

describe('auth config', () => {
  test('disabled without long secrets', () => {
    expect(loadAuthConfig({}).enabled).toBe(false);
    expect(loadAuthConfig({ AUTH_TOKEN_PEPPER: 'short', AUTH_ENCRYPTION_KEY: KEY }).enabled).toBe(false);
    expect(loadAuthConfig(ENV).enabled).toBe(true);
  });
});

describe('crypto helpers', () => {
  test('encrypt round-trip and tamper detection', () => {
    const blob = authCrypto.encryptString('secret-install', KEY);
    expect(blob).not.toContain('secret-install');
    expect(authCrypto.decryptString(blob, KEY)).toBe('secret-install');
    expect(authCrypto.decryptString(blob, 'x'.repeat(40))).toBeNull();
    expect(authCrypto.decryptString(blob.slice(0, -2) + 'AA', KEY)).toBeNull();
  });
  test('signed payload expires and rejects tampering', () => {
    const t = authCrypto.signPayload({ a: 1, t: Date.now() }, PEPPER);
    expect(authCrypto.verifyPayload(t, PEPPER, 1000).a).toBe(1);
    expect(authCrypto.verifyPayload(t, 'other', 1000)).toBeNull();
    expect(authCrypto.verifyPayload(authCrypto.signPayload({ t: Date.now() - 5000 }, PEPPER), PEPPER, 1000)).toBeNull();
  });
});

describe('provider registry', () => {
  test('only configured providers are listed', () => {
    expect(createProviderRegistry({}).list()).toEqual([]);
    expect(createProviderRegistry(ENV).list()).toEqual([{ id: 'google', label: 'Google' }]);
    expect(createProviderRegistry(ENV).get('github')).toBeNull();
  });
});

describe('google id token validation', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
  const base = () => ({ iss: 'https://accounts.google.com', aud: 'cid', sub: '123', exp: Math.floor(Date.now() / 1000) + 600,
    nonce: 'n1', email: 'a@b.co', email_verified: true, name: 'A' });
  function provider(claims, key = privateKey) {
    const fetchImpl = async (url) => (String(url).includes('certs')
      ? { ok: true, json: async () => ({ keys: [jwk] }) }
      : { ok: true, json: async () => ({ id_token: makeIdToken(claims, key) }) });
    return createGoogleProvider(ENV, fetchImpl);
  }
  const ex = (p) => p.exchange({ code: 'c', codeVerifier: 'v', redirectUri: 'http://x/cb', nonce: 'n1' });

  test('accepts a valid token', async () => {
    await expect(ex(provider(base()))).resolves.toEqual({ subject: '123', email: 'a@b.co', name: 'A' });
  });
  test.each([
    ['audience', { aud: 'other' }], ['issuer', { iss: 'https://evil.example' }], ['nonce', { nonce: 'nope' }],
    ['expiry', { exp: 1 }], ['unverified email', { email_verified: false }],
  ])('rejects bad %s', async (_n, patch) => {
    await expect(ex(provider({ ...base(), ...patch }))).rejects.toThrow();
  });
  test('rejects a token signed by another key', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    await expect(ex(provider(base(), other))).rejects.toThrow(/signature/);
  });
  test('start url carries PKCE and state', () => {
    const url = new URL(createGoogleProvider(ENV).buildAuthUrl({ state: 's', nonce: 'n', codeChallenge: 'c', redirectUri: 'http://x/cb' }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('s');
    expect(url.searchParams.get('scope')).toContain('openid');
  });
});

describe('service, store and device middleware', () => {
  let service;
  beforeEach(() => {
    const config = loadAuthConfig(ENV);
    service = new AuthService({ store: new AuthStore(':memory:'), config, providers: createProviderRegistry(ENV) });
  });

  test('same identity maps to the same account; different provider subject is separate', () => {
    const a = service.signInWithIdentity({ provider: 'google', subject: '1', email: 'A@x.co', name: 'A' });
    expect(service.signInWithIdentity({ provider: 'google', subject: '1', email: 'A@x.co' }).id).toBe(a.id);
    expect(service.signInWithIdentity({ provider: 'google', subject: '2', email: 'A@x.co' }).id).not.toBe(a.id);
  });

  test('sessions and device tokens validate, and revoke', () => {
    const u = service.signInWithIdentity({ provider: 'google', subject: '1', email: 'a@x.co' });
    const s = service.createSession(u.id);
    expect(service.getSessionUser(s).id).toBe(u.id);
    service.destroySession(s);
    expect(service.getSessionUser(s)).toBeNull();
    const { id, token } = service.createDeviceToken(u.id, 'TV');
    expect(service.authenticateDeviceToken(token).userId).toBe(u.id);
    expect(service.authenticateDeviceToken('nd_bogus')).toBeNull();
    service.revokeDevice(u.id, id);
    expect(service.authenticateDeviceToken(token)).toBeNull();
  });

  test('device settings are filtered and per device; leaf install validated + encrypted', () => {
    const u = service.signInWithIdentity({ provider: 'google', subject: '1', email: 'a@x.co' });
    const tv = service.createDeviceToken(u.id, 'TV');
    const phone = service.createDeviceToken(u.id, 'Phone');
    service.updateDevice(u.id, tv.id, { config: { sports: 'football', evil: 'x', timezone: 'UTC' }, name: 'Living room' });
    expect(service.getDevice(u.id, tv.id)).toMatchObject({ name: 'Living room', config: { sports: 'football', timezone: 'UTC' }, token: tv.token });
    expect(service.getDevice(u.id, phone.id).config).toEqual({});
    expect(service.authenticateDeviceToken(tv.token).config).toEqual({ sports: 'football', timezone: 'UTC' });
    expect(() => service.updateDevice(u.id, tv.id, { config: { sports: { a: 1 } } })).toThrow();
    const other = service.signInWithIdentity({ provider: 'google', subject: '2', email: 'b@x.co' });
    expect(service.getDevice(other.id, tv.id)).toBeNull();
    expect(() => service.updateDevice(other.id, tv.id, { name: 'x' })).toThrow();
    expect(() => service.updateSettings(u.id, { leafInstall: 'not a valid link !!' })).toThrow();
    const uuid = '123e4567-e89b-42d3-a456-426614174000';
    service.updateSettings(u.id, { leafInstall: uuid });
    const raw = service.store.getSettings(u.id).leaf_install_encrypted;
    expect(raw).not.toContain(uuid);
    expect(service.getLeafInstall(u.id).configured).toBe(true);
    service.updateSettings(u.id, { leafInstall: '' });
    expect(service.getLeafInstall(u.id)).toBeNull();
  });

  async function withServer(app, fn) {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
  }

  test('device middleware merges account config, strips spoofed __uid, rejects revoked tokens', async () => {
    const u = service.signInWithIdentity({ provider: 'google', subject: '1', email: 'a@x.co' });
    const { id, token } = service.createDeviceToken(u.id, 'TV');
    service.updateDevice(u.id, id, { config: { sports: 'tennis' } });
    const app = express();
    app.use(createDeviceConfigMiddleware({ service }));
    app.get('/:config/manifest.json', (req, res) => res.json({ cfg: JSON.parse(decodeURIComponent(req.params.config)), uid: req.nuvioUserId || null }));
    const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    await withServer(app, async (base) => {
      const ok = await (await fetch(`${base}/${seg({ a: token, teams: 'x', sports: 'golf' })}/manifest.json`)).json();
      expect(ok.cfg).toEqual({ teams: 'x', sports: 'tennis', __uid: u.id });
      expect(ok.cfg.a).toBeUndefined();
      const spoof = await (await fetch(`${base}/${seg({ __uid: 'victim', sports: 'golf' })}/manifest.json`)).json();
      expect(spoof.cfg.__uid).toBeUndefined();
      service.revokeDevice(u.id, id);
      expect((await fetch(`${base}/${seg({ a: token })}/manifest.json`)).status).toBe(401);
    });
  });

  test('auth routes: state cookie required, logout, settings need a session, cross-origin rejected', async () => {
    const config = loadAuthConfig(ENV);
    const app = express();
    app.use('/api/auth', createAuthRouter({ service, config, baseUrlFor: () => 'http://localhost:7000' }));
    await withServer(app, async (base) => {
      const prov = await (await fetch(`${base}/api/auth/providers`)).json();
      expect(prov.providers).toEqual([{ id: 'google', label: 'Google' }]);
      const start = await fetch(`${base}/api/auth/google/start`, { redirect: 'manual' });
      expect(start.status).toBe(302);
      expect(start.headers.get('location')).toContain('accounts.google.com');
      expect(start.headers.get('set-cookie')).toMatch(/HttpOnly/i);
      const cb = await fetch(`${base}/api/auth/google/callback?code=x&state=y`, { redirect: 'manual' });
      expect(cb.headers.get('location')).toContain('error=invalid_state');
      expect((await fetch(`${base}/api/auth/settings`)).status).toBe(401);
      const u = service.signInWithIdentity({ provider: 'google', subject: '1', email: 'a@x.co' });
      const cookie = `nuvio_session=${service.createSession(u.id)}`;
      const post = (origin) => fetch(`${base}/api/auth/devices`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ name: 'TV' }) });
      expect((await post('http://evil.example')).status).toBe(403);
      const dev = await post('http://localhost:7000');
      expect(dev.status).toBe(201);
      const { id } = await dev.json();
      const put = await fetch(`${base}/api/auth/devices/${id}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ config: { sports: 'golf' } }) });
      expect(put.status).toBe(200);
      const got = await (await fetch(`${base}/api/auth/devices/${id}`, { headers: { cookie } })).json();
      expect(got.config).toEqual({ sports: 'golf' });
      expect(got.manifestUrl).toMatch(/^http:\/\/localhost:7000\/.+\/manifest\.json$/);
      expect((await fetch(`${base}/api/auth/devices/nope`, { headers: { cookie } })).status).toBe(404);
    });
  });
});

describe('leaf state account claim', () => {
  test('round-trips u and rejects malformed u', () => {
    process.env.LEAF_STATE_SECRET = 's'.repeat(32);
    const leafState = require('../src/services/LeafState');
    const uid = crypto.randomUUID();
    expect(leafState.verify(leafState.sign({ m: 'match1', s: 'abc', u: uid })).u).toBe(uid);
    expect(leafState.verify(leafState.sign({ m: 'match1', s: 'abc' })).u).toBeUndefined();
    expect(() => leafState.sign({ m: 'match1', u: '../x' })).toThrow();
  });
});
