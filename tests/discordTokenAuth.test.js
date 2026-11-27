'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const acorn = require('acorn');
const { DatabaseSync } = require('node:sqlite');
const { loadAuthConfig } = require('../src/auth/authConfig');
const { AuthStore } = require('../src/auth/AuthStore');
const { AuthService, AuthError } = require('../src/auth/AuthService');
const { createProviderRegistry } = require('../src/auth/providers');
const { hasSignInMethods } = require('../src/auth');
const { createAuthRouter } = require('../src/routes/auth');
const authCrypto = require('../src/auth/AuthCrypto');

const PEPPER = 'p'.repeat(40);
const KEY = 'k'.repeat(40);
const BASE_ENV = {
  AUTH_TOKEN_PEPPER: PEPPER,
  AUTH_ENCRYPTION_KEY: KEY,
};
const APP_ID = '111111111111111111';
const GUILD_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';
const MEMBER_ID = '444444444444444444';
const CANONICAL_ORIGIN = 'http://localhost:7000';

function generateEd25519Fixture() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeyHex = spki.subarray(-32).toString('hex');
  return { publicKey, privateKey, publicKeyHex };
}

function signDiscordBody(rawBody, timestampSec, privateKey) {
  const msg = Buffer.concat([Buffer.from(String(timestampSec), 'utf8'), Buffer.from(rawBody, 'utf8')]);
  return crypto.sign(null, msg, privateKey).toString('hex');
}

function makeTempDbPath(name = 'accounts.sqlite') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-discord-auth-'));
  return { dir, dbPath: path.join(dir, name) };
}

describe('Discord access token persistence and redemption', () => {
  const cleanupDirs = [];
  const openStores = [];

  function trackStore(store) {
    openStores.push(store);
    return store;
  }

  function makeService(dbPath, nowRef = { value: 1_700_000_000_000 }) {
    const config = loadAuthConfig(BASE_ENV);
    const store = trackStore(new AuthStore(dbPath));
    const service = new AuthService({
      store,
      config,
      providers: createProviderRegistry(BASE_ENV),
      now: () => nowRef.value,
    });
    return { config, store, service, nowRef };
  }

  afterEach(() => {
    while (openStores.length) {
      const store = openStores.pop();
      try { store.close(); } catch (_) { /* ignore already closed */ }
    }
    while (cleanupDirs.length) {
      const dir = cleanupDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates an existing v1 accounts database cleanly without losing existing data', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);

    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE auth_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE users (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, disabled_at INTEGER
      );
      CREATE TABLE identities (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, provider_subject TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, UNIQUE(provider, provider_subject)
      );
      CREATE TABLE browser_sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE device_tokens (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT '', expires_at INTEGER, revoked_at INTEGER, last_used_at INTEGER, created_at INTEGER NOT NULL,
        addon_config_json TEXT NOT NULL DEFAULT '{}', token_encrypted TEXT
      );
      INSERT INTO auth_schema_migrations (version, applied_at) VALUES (1, 1000);
      INSERT INTO users (id, display_name, email, created_at) VALUES ('u1', 'Existing User', 'u@example.com', 1000);
      INSERT INTO identities (id, user_id, provider, provider_subject, email, created_at)
        VALUES ('i1', 'u1', 'google', 'g-1', 'u@example.com', 1000);
    `);
    legacy.close();

    const { store, service } = makeService(dbPath);
    expect(store.getUser('u1').display_name).toBe('Existing User');
    expect(store.findUserByIdentity('google', 'g-1').id).toBe('u1');
    const version = store.db.prepare('SELECT MAX(version) AS v FROM auth_schema_migrations').get().v;
    expect(version).toBeGreaterThanOrEqual(2);

    const issued = service.issueDiscordAccessToken({ interactionId: 'int-1', subject: '424242424242424242', name: 'Discord User' });
    expect(issued.token).toMatch(/^nt_[A-Za-z0-9_-]{32}$/);
  });

  test('issues private hashed permanent token without creating identity early, rejects duplicate interaction IDs, and keeps tokens across later issuances', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const { store, service } = makeService(dbPath, nowRef);

    const signedAtMs = nowRef.value + 20_000;
    const issued = service.issueDiscordAccessToken({
      interactionId: 'int-skew',
      subject: '111111111111111111',
      name: 'Alice',
      signedAtMs,
    });
    expect(issued).toEqual({
      token: expect.stringMatching(/^nt_[A-Za-z0-9_-]{32}$/),
      expiresAt: null,
    });

    // Token plaintext is never stored and no Discord user/identity exists before redemption.
    const rawRows = store.db.prepare('SELECT token_hash, expires_at, retain_until FROM discord_access_tokens').all();
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].token_hash).toBe(authCrypto.hashOpaqueToken(issued.token, PEPPER));
    expect(rawRows[0].token_hash).not.toContain(issued.token);
    expect(rawRows[0].expires_at).toBe(0);
    expect(rawRows[0].retain_until).toBe(signedAtMs + 300_000);
    expect(store.findUserByIdentity('discord', '111111111111111111')).toBeNull();

    // Immediate duplicate delivery returns null.
    expect(service.issueDiscordAccessToken({
      interactionId: 'int-skew',
      subject: '111111111111111111',
      name: 'Alice',
      signedAtMs,
    })).toBeNull();

    // Redeem with surrounding whitespace.
    const redeemed = service.redeemDiscordAccessToken(`  \n${issued.token}\t `);
    expect(redeemed.sessionToken).toMatch(/^ns_/);
    const firstUserId = service.getSessionUser(redeemed.sessionToken).id;

    // Even 30 days later and after issuing tokens for other users, the permanent token remains usable
    // and the duplicate interaction ID still cannot mint a second token.
    nowRef.value += 30 * 86_400_000;
    const second = service.issueDiscordAccessToken({
      interactionId: 'int-other',
      subject: '222222222222222222',
      name: 'Bob',
      signedAtMs: nowRef.value,
    });
    expect(second).not.toBeNull();
    expect(service.issueDiscordAccessToken({
      interactionId: 'int-skew',
      subject: '111111111111111111',
      name: 'Alice',
      signedAtMs,
    })).toBeNull();

    const reused = service.redeemDiscordAccessToken(issued.token);
    expect(reused.sessionToken).toMatch(/^ns_/);
    expect(service.getSessionUser(reused.sessionToken).id).toBe(firstUserId);
  });

  test('never expires permanent tokens and rejects malformed or unknown tokens', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const { service } = makeService(dbPath, nowRef);

    const permanent = service.issueDiscordAccessToken({
      interactionId: 'int-perm',
      subject: '111111111111111111',
      name: 'Alice',
    });
    nowRef.value += 365 * 86_400_000;
    expect(service.redeemDiscordAccessToken(permanent.token).sessionToken).toMatch(/^ns_/);

    for (const bad of ['', '   ', null, undefined, 123, 'nd_abc', 'nt_bad', authCrypto.createOpaqueToken('nt', 24)]) {
      expect(() => service.redeemDiscordAccessToken(bad)).toThrow(expect.objectContaining({ code: 'invalid_access_token' }));
    }
  });

  test('reuses the same Discord account across repeated logins, stores no email, and never merges with Google', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const { store, service } = makeService(dbPath, nowRef);

    const googleUser = service.signInWithIdentity({
      provider: 'google',
      subject: 'g-alice',
      email: 'alice@example.com',
      name: 'Alice',
    });

    const t1 = service.issueDiscordAccessToken({ interactionId: 'int-1', subject: '555555555555555555', name: 'Alice' });
    const s1 = service.redeemDiscordAccessToken(t1.token);
    const u1 = service.getSessionUser(s1.sessionToken);
    expect(u1.id).not.toBe(googleUser.id);
    expect(u1.email).toBe('');
    expect(u1.display_name).toBe('Alice');
    expect(store.listIdentities(u1.id)).toEqual([
      expect.objectContaining({ provider: 'discord', email: '' }),
    ]);

    nowRef.value += 10_000;
    const t2 = service.issueDiscordAccessToken({ interactionId: 'int-2', subject: '555555555555555555', name: 'Alice Renamed' });
    const s2 = service.redeemDiscordAccessToken(t2.token);
    const u2 = service.getSessionUser(s2.sessionToken);
    expect(u2.id).toBe(u1.id);
  });

  test('rejects disabled Discord accounts with invalid_access_token and creates no session', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const { store, service } = makeService(dbPath, nowRef);

    const t1 = service.issueDiscordAccessToken({ interactionId: 'int-1', subject: '666666666666666666', name: 'Banned' });
    const { sessionToken } = service.redeemDiscordAccessToken(t1.token);
    const user = service.getSessionUser(sessionToken);
    store.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(nowRef.value, user.id);

    const t2 = service.issueDiscordAccessToken({ interactionId: 'int-2', subject: '666666666666666666', name: 'Banned' });
    expect(() => service.redeemDiscordAccessToken(t2.token)).toThrow(expect.objectContaining({
      code: 'invalid_access_token',
      status: 401,
    }));
    const sessions = store.db.prepare('SELECT COUNT(*) AS c FROM browser_sessions WHERE user_id = ?').get(user.id).c;
    expect(sessions).toBe(1);
  });

  test('two connections competing to redeem one permanent token both succeed and resolve to the same account', async () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const workerA = makeService(dbPath, nowRef);
    const workerB = makeService(dbPath, nowRef);

    const issued = workerA.service.issueDiscordAccessToken({
      interactionId: 'int-race',
      subject: '777777777777777777',
      name: 'Racer',
    });

    const results = await Promise.all([
      Promise.resolve().then(() => workerA.service.redeemDiscordAccessToken(issued.token)),
      Promise.resolve().then(() => workerB.service.redeemDiscordAccessToken(issued.token)),
    ]);

    expect(results[0].sessionToken).toMatch(/^ns_/);
    expect(results[1].sessionToken).toMatch(/^ns_/);
    expect(workerA.service.getSessionUser(results[0].sessionToken).id)
      .toBe(workerB.service.getSessionUser(results[1].sessionToken).id);
  });

  test('rolls back token claim if session insertion fails so the token stays redeemable on recovery', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const { store, service } = makeService(dbPath, nowRef);

    const issued = service.issueDiscordAccessToken({
      interactionId: 'int-fault',
      subject: '888888888888888888',
      name: 'FaultUser',
    });

    const spy = jest.spyOn(store, '_insertSession').mockImplementationOnce(() => {
      throw new Error('simulated session write failure');
    });

    expect(() => service.redeemDiscordAccessToken(issued.token)).toThrow('simulated session write failure');
    expect(spy).toHaveBeenCalledTimes(1);

    // Storage recovers: same token still redeems cleanly and creates a valid session.
    const redeemed = service.redeemDiscordAccessToken(issued.token);
    expect(redeemed.sessionToken).toMatch(/^ns_/);
    expect(service.getSessionUser(redeemed.sessionToken).display_name).toBe('FaultUser');
  });

  test('bounds SQLite lock wait for issuance to 500 ms and raises storage_busy when writer is locked', () => {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const nowRef = { value: 1_700_000_000_000 };
    const locker = makeService(dbPath, nowRef);
    const issuer = makeService(dbPath, nowRef);

    locker.store.db.exec('BEGIN IMMEDIATE');
    const start = Date.now();
    try {
      expect(() => issuer.service.issueDiscordAccessToken({
        interactionId: 'int-busy',
        subject: '999999999999999999',
        name: 'BusyUser',
      })).toThrow(expect.objectContaining({ code: 'storage_busy', status: 503 }));
    } finally {
      locker.store.db.exec('ROLLBACK');
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(2000);
    expect(issuer.store.db.prepare('PRAGMA busy_timeout').get().timeout).toBe(5000);
  });
});

describe('Discord auth configuration, sign-in availability, interactions, and browser redemption', () => {
  const cleanupDirs = [];
  const openStores = [];

  afterEach(() => {
    while (openStores.length) {
      const store = openStores.pop();
      try { store.close(); } catch (_) { /* ignore */ }
    }
    while (cleanupDirs.length) {
      fs.rmSync(cleanupDirs.pop(), { recursive: true, force: true });
    }
  });

  async function withServer(app, fn) {
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  function makeDiscordEnv(publicKeyHex, overrides = {}) {
    return {
      ...BASE_ENV,
      ADDON_URL: CANONICAL_ORIGIN,
      AUTH_DISCORD_APPLICATION_ID: APP_ID,
      AUTH_DISCORD_PUBLIC_KEY: publicKeyHex,
      AUTH_DISCORD_GUILD_ID: GUILD_ID,
      ...overrides,
    };
  }

  function mountAuth(env, nowRef = { value: 1_700_000_000_000 }, routerOpts = {}) {
    const { dir, dbPath } = makeTempDbPath();
    cleanupDirs.push(dir);
    const config = loadAuthConfig(env);
    const store = new AuthStore(dbPath);
    openStores.push(store);
    const providers = createProviderRegistry(env);
    const service = config.enabled
      ? new AuthService({ store, config, providers, now: () => nowRef.value })
      : null;
    const app = express();
    app.use('/api/auth', createAuthRouter({
      service: service || { providers: { list: () => [], get: () => null } },
      config,
      baseUrlFor: () => config.publicUrl || CANONICAL_ORIGIN,
      now: () => nowRef.value,
      ...routerOpts,
    }));
    return { app, config, store, service, dbPath, nowRef };
  }

  test('validates Discord config strictly and evaluates hasSignInMethods for all provider combinations', () => {
    const { publicKeyHex } = generateEd25519Fixture();
    const valid = makeDiscordEnv(publicKeyHex);
    expect(loadAuthConfig(valid).discord.enabled).toBe(true);
    expect(loadAuthConfig(valid).discord.canonicalOrigin).toBe(CANONICAL_ORIGIN);
    expect(loadAuthConfig(makeDiscordEnv(publicKeyHex, { ADDON_URL: 'https://nuviosports.xyz/' })).discord.canonicalOrigin)
      .toBe('https://nuviosports.xyz');
    expect(loadAuthConfig(makeDiscordEnv(publicKeyHex, { AUTH_DISCORD_ROLE_ID: ROLE_ID })).discord.enabled).toBe(true);

    // Invalid configs must disable Discord token sign-in (fail closed).
    const invalidVariants = [
      { AUTH_TOKEN_PEPPER: 'short' },
      { ADDON_URL: '' },
      { ADDON_URL: 'http://nuviosports.xyz' },
      { ADDON_URL: 'https://nuviosports.xyz/subpath' },
      { ADDON_URL: 'https://user:pass@nuviosports.xyz' },
      { AUTH_DISCORD_APPLICATION_ID: 'not-a-snowflake' },
      { AUTH_DISCORD_GUILD_ID: 'guild-1' },
      { AUTH_DISCORD_PUBLIC_KEY: 'abcd' },
      { AUTH_DISCORD_PUBLIC_KEY: 'z'.repeat(64) },
      { AUTH_DISCORD_ROLE_ID: 'bad-role-id' },
    ];
    for (const patch of invalidVariants) {
      expect(loadAuthConfig(makeDiscordEnv(publicKeyHex, patch)).discord.enabled).toBe(false);
    }

    // Availability checks across Google only, Discord only, both, neither.
    const googleOnlyEnv = { ...BASE_ENV, AUTH_GOOGLE_CLIENT_ID: 'cid', AUTH_GOOGLE_CLIENT_SECRET: 'sec' };
    const bothEnv = { ...valid, AUTH_GOOGLE_CLIENT_ID: 'cid', AUTH_GOOGLE_CLIENT_SECRET: 'sec' };
    const makePair = (env) => {
      const cfg = loadAuthConfig(env);
      const svc = cfg.enabled ? new AuthService({ store: openStores[openStores.push(new AuthStore(':memory:')) - 1], config: cfg, providers: createProviderRegistry(env) }) : null;
      return { config: cfg, service: svc };
    };
    expect(hasSignInMethods(makePair({}))).toBe(false);
    expect(hasSignInMethods(makePair(BASE_ENV))).toBe(false);
    expect(hasSignInMethods(makePair(googleOnlyEnv))).toBe(true);
    expect(hasSignInMethods(makePair(valid))).toBe(true);
    expect(hasSignInMethods(makePair(bothEnv))).toBe(true);
  });

  test('reports providers and accessTokenEnabled across Google-only, Discord-only, both, and neither', async () => {
    const { publicKeyHex } = generateEd25519Fixture();
    const cases = [
      [{}, { enabled: false, providers: [], accessTokenEnabled: false }],
      [BASE_ENV, { enabled: true, providers: [], accessTokenEnabled: false }],
      [{ ...BASE_ENV, AUTH_GOOGLE_CLIENT_ID: 'cid', AUTH_GOOGLE_CLIENT_SECRET: 'sec' }, { enabled: true, providers: [{ id: 'google', label: 'Google' }], accessTokenEnabled: false }],
      [makeDiscordEnv(publicKeyHex), { enabled: true, providers: [], accessTokenEnabled: true }],
      [makeDiscordEnv(publicKeyHex, { AUTH_GOOGLE_CLIENT_ID: 'cid', AUTH_GOOGLE_CLIENT_SECRET: 'sec' }), { enabled: true, providers: [{ id: 'google', label: 'Google' }], accessTokenEnabled: true }],
    ];
    for (const [env, expected] of cases) {
      const { app } = mountAuth(env);
      await withServer(app, async (base) => {
        const res = await fetch(`${base}/api/auth/providers`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual(expected);
      });
    }
  });

  test('handles Discord PING, verified /token issuance, duplicates with future skew, signature/timestamp errors, and ineligible requests', async () => {
    const fixture = generateEd25519Fixture();
    const otherFixture = generateEd25519Fixture();
    const nowRef = { value: 1_700_000_000_000 };
    const { app, store, dbPath } = mountAuth(
      makeDiscordEnv(fixture.publicKeyHex, { AUTH_DISCORD_ROLE_ID: ROLE_ID }),
      nowRef
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withServer(app, async (base) => {
        const sendInteraction = (payload, {
          tsSec = Math.floor(nowRef.value / 1000),
          privKey = fixture.privateKey,
          sigOverride = null,
          rawOverride = null,
        } = {}) => {
          const raw = rawOverride !== null ? rawOverride : JSON.stringify(payload);
          const sig = sigOverride !== null ? sigOverride : signDiscordBody(raw, tsSec, privKey);
          return fetch(`${base}/api/auth/discord/interactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-signature-ed25519': sig,
              'x-signature-timestamp': String(tsSec),
            },
            body: raw,
          });
        };

        // 1. Verified PING -> { type: 1 }
        const ping = await sendInteraction({ id: '1', application_id: APP_ID, type: 1 });
        expect(ping.status).toBe(200);
        expect(await ping.json()).toEqual({ type: 1 });

        // 2. Invalid signature, wrong key, tampered body, stale timestamp, >30s future command -> 401
        expect((await sendInteraction({ id: '2', application_id: APP_ID, type: 1 }, { privKey: otherFixture.privateKey })).status).toBe(401);
        expect((await sendInteraction({ id: '3', application_id: APP_ID, type: 1 }, { sigOverride: '00'.repeat(64) })).status).toBe(401);
        expect((await sendInteraction({ id: '4', application_id: APP_ID, type: 1 }, { tsSec: Math.floor(nowRef.value / 1000) - 301 })).status).toBe(401);
        expect((await sendInteraction({
          id: '5', application_id: APP_ID, guild_id: GUILD_ID, type: 2,
          data: { type: 1, name: 'token' },
          member: { roles: [ROLE_ID], user: { id: MEMBER_ID, username: 'alice' } },
        }, { tsSec: Math.floor(nowRef.value / 1000) + 31 })).status).toBe(401);

        // 3. Wrong app, wrong guild, missing role, wrong command -> no issuance
        const wrongApp = await sendInteraction({
          id: '6', application_id: '999999999999999999', guild_id: GUILD_ID, type: 2,
          data: { type: 1, name: 'token' },
          member: { roles: [ROLE_ID], user: { id: MEMBER_ID, username: 'alice' } },
        });
        expect(wrongApp.status).toBeGreaterThanOrEqual(400);

        const wrongGuild = await sendInteraction({
          id: '7', application_id: APP_ID, guild_id: '999999999999999999', type: 2,
          data: { type: 1, name: 'token' },
          member: { roles: [ROLE_ID], user: { id: MEMBER_ID, username: 'alice' } },
        });
        expect((await wrongGuild.json()).data.flags).toBe(64);

        const missingRole = await sendInteraction({
          id: '8', application_id: APP_ID, guild_id: GUILD_ID, type: 2,
          data: { type: 1, name: 'token' },
          member: { roles: ['888888888888888888'], user: { id: MEMBER_ID, username: 'alice' } },
        });
        expect((await missingRole.json()).data.flags).toBe(64);

        const wrongCmd = await sendInteraction({
          id: '9', application_id: APP_ID, guild_id: GUILD_ID, type: 2,
          data: { type: 1, name: 'other' },
          member: { roles: [ROLE_ID], user: { id: MEMBER_ID, username: 'alice' } },
        });
        expect((await wrongCmd.json()).data.flags).toBe(64);
        expect(store.db.prepare('SELECT COUNT(*) AS c FROM discord_access_tokens').get().c).toBe(0);

        // 4. Eligible /token with +20s future clock skew -> ephemeral reply with token
        const skewedTs = Math.floor(nowRef.value / 1000) + 20;
        const okPayload = {
          id: 'int-valid-1',
          application_id: APP_ID,
          guild_id: GUILD_ID,
          type: 2,
          data: { type: 1, name: 'token' },
          member: { roles: [ROLE_ID], nick: 'Alice Nuvio', user: { id: MEMBER_ID, username: 'alice' } },
        };
        const okRes = await sendInteraction(okPayload, { tsSec: skewedTs });
        expect(okRes.status).toBe(200);
        const okJson = await okRes.json();
        expect(okJson.type).toBe(4);
        expect(okJson.data.flags).toBe(64);
        const match = okJson.data.content.match(/nt_[A-Za-z0-9_-]{32}/);
        expect(match).not.toBeNull();
        expect(store.db.prepare('SELECT COUNT(*) AS c FROM discord_access_tokens').get().c).toBe(1);

        // 5. Duplicate interaction ID returns private notice without minting a second token
        const dupRes = await sendInteraction(okPayload, { tsSec: skewedTs });
        expect(dupRes.status).toBe(200);
        const dupJson = await dupRes.json();
        expect(dupJson.type).toBe(4);
        expect(dupJson.data.flags).toBe(64);
        expect(dupJson.data.content).not.toMatch(/nt_[A-Za-z0-9_-]{32}/);
        expect(store.db.prepare('SELECT COUNT(*) AS c FROM discord_access_tokens').get().c).toBe(1);

        // 6. Oversized >16 KiB payload is rejected
        const bigBody = JSON.stringify({ id: 'big', application_id: APP_ID, type: 1, pad: 'x'.repeat(20 * 1024) });
        expect((await sendInteraction({}, { rawOverride: bigBody })).status).toBe(413);

        // 7. SQLite contention returns private ephemeral retry message within ~500 ms
        const locker = new AuthStore(dbPath);
        openStores.push(locker);
        locker.db.exec('BEGIN IMMEDIATE');
        let busyRes;
        try {
          busyRes = await sendInteraction({
            id: 'int-busy-http',
            application_id: APP_ID,
            guild_id: GUILD_ID,
            type: 2,
            data: { type: 1, name: 'token' },
            member: { roles: [ROLE_ID], user: { id: MEMBER_ID, username: 'alice' } },
          });
        } finally {
          locker.db.exec('ROLLBACK');
        }
        expect(busyRes.status).toBe(200);
        const busyJson = await busyRes.json();
        expect(busyJson.type).toBe(4);
        expect(busyJson.data.flags).toBe(64);
        expect(busyJson.data.content).not.toMatch(/nt_[A-Za-z0-9_-]{32}/);
      });

      const logged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].flat().join(' ');
      expect(logged).not.toContain('nt_');
      expect(logged).not.toContain('Alice Nuvio');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('redeems token only from exact canonical origin, normalizes return paths, sets session cookie, and rate-limits per proxy client IP', async () => {
    const fixture = generateEd25519Fixture();
    const nowRef = { value: 1_700_000_000_000 };
    const { app, service } = mountAuth(makeDiscordEnv(fixture.publicKeyHex), nowRef, {
      redeemRateLimit: { max: 3, windowMs: 60_000 },
    });

    const { token } = service.issueDiscordAccessToken({
      interactionId: 'int-web-1',
      subject: MEMBER_ID,
      name: 'Web User',
    });

    await withServer(app, async (base) => {
      const redeem = (body, headers = {}) => fetch(`${base}/api/auth/access-token/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

      // Missing and foreign origins (scheme, host, or port mismatch) get 403 and leave token usable.
      for (const badOrigin of [undefined, 'https://localhost:7000', 'http://localhost:7001', 'http://evil.example', 'null']) {
        const res = await redeem({ token, returnTo: '/configure' }, badOrigin ? { origin: badOrigin } : {});
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'cross_origin' });
      }

      // Same canonical origin succeeds!
      const okRes = await redeem({ token: ` ${token} `, returnTo: '/configure?device=dev1' }, {
        origin: CANONICAL_ORIGIN,
        'cf-connecting-ip': '203.0.113.10',
      });
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('cache-control')).toBe('no-store');
      expect(await okRes.json()).toEqual({ ok: true, redirectTo: '/configure?device=dev1' });
      const setCookie = okRes.headers.get('set-cookie') || '';
      expect(setCookie).toMatch(/nuvio_session=ns_/);
      expect(setCookie).toMatch(/HttpOnly/i);
      const cookieHeader = setCookie.split(';')[0];

      // Session works on /api/auth/me without storing email.
      const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieHeader } })).json();
      expect(me).toMatchObject({
        authenticated: true,
        user: { name: 'Web User', email: '' },
      });

      // Reusing the same permanent token also succeeds across logins.
      const reuse = await redeem({ token }, { origin: CANONICAL_ORIGIN, 'cf-connecting-ip': '203.0.113.10' });
      expect(reuse.status).toBe(200);
      expect(await reuse.json()).toEqual({ ok: true, redirectTo: '/account' });

      // Invalid/dangerous returnTo destinations normalize back to /account.
      const badReturns = [undefined, '', '//evil.example', 'https://evil.example/x', '/api/auth/me', '/api', '/foo/../api/secret'];
      for (let idx = 0; idx < badReturns.length; idx += 1) {
        const badReturn = badReturns[idx];
        const fresh = service.issueDiscordAccessToken({
          interactionId: `int-ret-${idx}`,
          subject: MEMBER_ID,
          name: 'Web User',
        });
        const r = await redeem({ token: fresh.token, returnTo: badReturn }, {
          origin: CANONICAL_ORIGIN,
          'cf-connecting-ip': `203.0.113.${100 + idx}`,
        });
        expect(r.status).toBe(200);
        expect((await r.json()).redirectTo).toBe('/account');
      }

      // Client 203.0.113.10 hits rate limit (max=3 -> 2 used above, 3rd ok/401, 4th -> 429)
      const third = await redeem({ token: 'bad' }, { origin: CANONICAL_ORIGIN, 'cf-connecting-ip': '203.0.113.10' });
      expect(third.status).toBe(401);
      const fourth = await redeem({ token: 'bad' }, { origin: CANONICAL_ORIGIN, 'cf-connecting-ip': '203.0.113.10' });
      expect(fourth.status).toBe(429);
      expect((await fourth.json()).error).toBe('rate_limited');
      expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);

      // Separate client IP is unaffected.
      const otherClient = await redeem({ token: 'bad' }, { origin: CANONICAL_ORIGIN, 'cf-connecting-ip': '203.0.113.30' });
      expect(otherClient.status).toBe(401);
    });
  });

  test('index.js uses hasSignInMethods for both page gating and Configure while keeping addon routes open', () => {
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    const matches = indexSrc.match(/hasSignInMethods\(/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(indexSrc.indexOf("app.use('/api/auth'")).toBeLessThan(indexSrc.indexOf('PublicResolverApiGate'));
    // Public addon paths stay outside the page gate regex.
    const pageMatch = /const PAGE = (\/[^;]+);/.exec(indexSrc);
    expect(pageMatch).not.toBeNull();
    const pageRe = eval(pageMatch[1]);
    expect(pageRe.test('/')).toBe(true);
    expect(pageRe.test('/configure')).toBe(true);
    expect(pageRe.test('/status')).toBe(true);
    expect(pageRe.test('/manifest.json')).toBe(false);
    expect(pageRe.test('/catalog/tv/live.json')).toBe(false);
    expect(pageRe.test('/stream/tv/match1.json')).toBe(false);
  });
});

describe('Account page Google / Access token UI', () => {
  const accountHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.html'), 'utf8');
  const scriptMatch = accountHtml.match(/<script>\s*\(function\s*\(\)[\s\S]*?<\/script>/);
  const inlineScript = scriptMatch ? scriptMatch[0].replace(/^<script>|<\/script>$/g, '') : '';

  test('inline script parses cleanly without syntax errors', () => {
    expect(inlineScript.length).toBeGreaterThan(500);
    expect(() => acorn.parse(inlineScript, { ecmaVersion: 2020 })).not.toThrow();
  });

  test('exposes accessible Google and Access token tabs, invite link, and distinct privacy copy without Discord OAuth', () => {
    expect(accountHtml).toContain('role="tablist"');
    expect(accountHtml).toContain('id="tabGoogle"');
    expect(accountHtml).toContain('aria-controls="panelGoogle"');
    expect(accountHtml).toContain('id="tabToken"');
    expect(accountHtml).toContain('aria-controls="panelToken"');
    expect(accountHtml).toContain('id="accessTokenInput"');
    expect(accountHtml).toContain('autocomplete="one-time-code"');
    expect(accountHtml).toContain('autocapitalize="none"');
    expect(accountHtml).toContain('spellcheck="false"');
    expect(accountHtml).toContain('Sign in with token');
    expect(accountHtml).toContain('https://discord.gg/24BAkjSfSe');
    expect(accountHtml).toContain('Open Nuvio Discord');
    expect(accountHtml).toContain('It does not expire and can be reused on your devices.');
    expect(accountHtml).toContain('We only store your name, email, and Google account ID.');
    expect(accountHtml).toContain('We only store your Discord display name and Discord user ID. No email address is stored.');
    expect(accountHtml).not.toMatch(/Continue with Discord/i);
  });

  test('wires keyboard tab switching, duplicate submit guard, error messaging, and canonical redirect', () => {
    expect(inlineScript).toContain("api('/access-token/redeem'");
    expect(inlineScript).toContain('This token is invalid or disabled. Run /token in Discord to get a new one.');
    expect(inlineScript).toContain("ev.key === 'ArrowRight' || ev.key === 'ArrowLeft'");
    expect(inlineScript).toContain("ev.key === 'Home'");
    expect(inlineScript).toContain("ev.key === 'End'");
    expect(inlineScript).toContain('if (tokenSubmitting) return;');
    expect(inlineScript).toContain("inp.value = ''");
    expect(inlineScript).toContain('location.replace(dest)');
  });
});

