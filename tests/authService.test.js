'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const SQLiteAuthRepository = require('../src/auth/SQLiteAuthRepository');
const AuthService = require('../src/auth/AuthService');
const PlaybackGrantService = require('../src/auth/PlaybackGrantService');

describe('account authentication services', () => {
  let dir;
  let repository;
  let authService;
  let playbackGrantService;
  const config = {
    tokenPepper: 'test-pepper-with-at-least-thirty-two-characters',
    sessionTtlMs: 60_000,
    deviceTokenTtlMs: 0,
    playbackTtlMs: 60_000,
    playbackSessionTtlMs: 120_000,
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-auth-'));
    repository = new SQLiteAuthRepository({ filename: path.join(dir, 'auth.sqlite') });
    authService = new AuthService({ repository, config });
    playbackGrantService = new PlaybackGrantService({ repository, authService, config });
  });

  afterEach(() => {
    repository.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('registers, normalizes email, and creates a browser session', async () => {
    const user = await authService.register('  PERSON@Example.com ', 'correct horse battery');
    expect(user.email).toBe('person@example.com');

    const login = await authService.login('person@example.com', 'correct horse battery');
    expect(login.token).toMatch(/^nuvio_session_/);
    expect(authService.getSession(login.token).user.email).toBe('person@example.com');
    expect(authService.logout(login.token)).toBe(true);
    expect(authService.getSession(login.token)).toBeNull();
  });

  test('rejects duplicate accounts and invalid credentials', async () => {
    await authService.register('person@example.com', 'correct horse battery');
    await expect(authService.register('PERSON@example.com', 'another secure password'))
      .rejects.toMatchObject({ code: 'email_exists', status: 409 });
    await expect(authService.login('person@example.com', 'wrong password'))
      .rejects.toMatchObject({ code: 'invalid_credentials', status: 401 });
  });

  test('locks an account after repeated failures', async () => {
    await authService.register('person@example.com', 'correct horse battery');
    for (let index = 0; index < 5; index++) {
      await expect(authService.login('person@example.com', 'wrong password')).rejects.toBeTruthy();
    }
    await expect(authService.login('person@example.com', 'correct horse battery'))
      .rejects.toMatchObject({ code: 'account_locked', status: 429 });
  });

  test('mints, validates, lists, and revokes device access', async () => {
    const user = await authService.register('person@example.com', 'correct horse battery');
    const created = authService.createDevice(user.id, 'Living room');
    expect(created.token).toMatch(/^nd_[A-Za-z0-9_-]{22}$/);
    expect(authService.listDevices(user.id)[0].name).toBe('Living room');

    const device = authService.validateDeviceToken(created.token);
    expect(device).toMatchObject({ userId: user.id, deviceName: 'Living room' });
    expect(authService.revokeDevice(user.id, created.device.id)).toBe(true);
    expect(() => authService.validateDeviceToken(created.token))
      .toThrow(expect.objectContaining({ code: 'device_revoked' }));
    expect(authService.deleteDevice(user.id, created.device.id)).toBe(true);
    expect(authService.listDevices(user.id)).toEqual([]);
  });

  test('playback grants reject tampering and revoked devices', async () => {
    const user = await authService.register('person@example.com', 'correct horse battery');
    const created = authService.createDevice(user.id, 'TV');
    const device = authService.validateDeviceToken(created.token);
    const grant = playbackGrantService.mint(device);
    expect(playbackGrantService.validate(grant)).toMatchObject({ deviceId: created.device.id, userId: user.id });
    expect(() => playbackGrantService.validate(grant + 'x'))
      .toThrow(expect.objectContaining({ code: 'invalid_playback_grant' }));

    authService.revokeDevice(user.id, created.device.id);
    expect(() => playbackGrantService.validate(grant))
      .toThrow(expect.objectContaining({ code: 'device_revoked' }));
  });

  test('playback grants expire and retain a bounded renewal session', async () => {
    const user = await authService.register('expiry@example.com', 'correct horse battery');
    const created = authService.createDevice(user.id, 'TV');
    const device = authService.validateDeviceToken(created.token);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const grant = playbackGrantService.mint(device);
      const context = playbackGrantService.validate(grant);
      expect(context.playbackSessionExpiresAt).toBe(121_000);
      now.mockReturnValue(61_001);
      expect(() => playbackGrantService.validate(grant))
        .toThrow(expect.objectContaining({ code: 'playback_grant_expired' }));
    } finally {
      now.mockRestore();
    }
  });

  test('browser playback grants follow the login session lifecycle', async () => {
    await authService.register('browser@example.com', 'correct horse battery');
    const login = await authService.login('browser@example.com', 'correct horse battery');
    const session = authService.getSession(login.token);
    const grant = playbackGrantService.mintBrowser({
      browserSessionId: session.sessionId,
      userId: session.user.id,
      expiresAt: session.expiresAt,
    });
    expect(playbackGrantService.validate(grant)).toMatchObject({
      browserSessionId: session.sessionId,
      userId: session.user.id,
    });
    authService.logout(login.token);
    expect(() => playbackGrantService.validate(grant))
      .toThrow(expect.objectContaining({ code: 'invalid_browser_session' }));
  });
});
