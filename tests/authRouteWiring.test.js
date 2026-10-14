'use strict';

const fs = require('fs');
const path = require('path');
const { loadAuthConfig } = require('../src/config');

const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

describe('authentication route wiring', () => {
  test('account APIs and public support routes are mounted before the resolver proxy', () => {
    const authAt = index.indexOf("app.use('/api/auth'");
    const playbackAt = index.indexOf("app.use('/api', requirePlaybackGrant)");
    const proxyAt = index.indexOf("app.use('/api', createProxyMiddleware");
    expect(authAt).toBeGreaterThan(-1);
    expect(playbackAt).toBeGreaterThan(authAt);
    expect(proxyAt).toBeGreaterThan(playbackAt);
  });

  test('serves account aliases and protects watch playback', () => {
    expect(index).toContain("app.get(['/account', '/login', '/register']");
    expect(index).toContain("app.use('/watch', requirePlaybackGrant)");
  });

  test('validates and sanitizes configured protocol requests', () => {
    expect(index).toContain('authenticateAddonConfig(withCompact');
    expect(index).toContain("mintPlayback: rest.startsWith('/stream/')");
    expect(index).toContain("code: 'authentication_required'");
  });

  test('provides session-authenticated home dashboard routes', () => {
    const authRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
    expect(authRoute).toContain("router.get('/web/catalog/:id', requireSession");
    expect(authRoute).toContain("router.get('/web/stream/:id', requireSession");
    expect(authRoute).toContain('playbackGrantService.mintBrowser');
  });
});

describe('authentication configuration', () => {
  test('requires a strong pepper when access enforcement is enabled', () => {
    expect(() => loadAuthConfig({ AUTH_REQUIRED: 'true', AUTH_TOKEN_PEPPER: 'short' }))
      .toThrow(/at least 32 characters/);
  });

  test('supports anonymous migration mode and SQLite defaults', () => {
    const config = loadAuthConfig({ AUTH_REQUIRED: 'false' });
    expect(config.required).toBe(false);
    expect(config.dbDriver).toBe('sqlite');
    expect(config.deviceTokenTtlMs).toBe(0);
  });

  test('enables secure cookies for managed HTTPS hosting URLs', () => {
    expect(loadAuthConfig({ RENDER_EXTERNAL_URL: 'https://nuvio.example' }).cookieSecure).toBe(true);
    expect(loadAuthConfig({ WEBSITE_HOSTNAME: 'nuvio.azurewebsites.net' }).cookieSecure).toBe(true);
  });
});
