'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

describe('account HTTP API', () => {
  let dir;
  let server;
  let origin;
  let closeAuthContext;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-auth-api-'));
    process.env.AUTH_REQUIRED = 'true';
    process.env.AUTH_TOKEN_PEPPER = 'api-test-pepper-with-at-least-thirty-two-characters';
    process.env.AUTH_DB_PATH = path.join(dir, 'auth.sqlite');
    process.env.AUTH_COOKIE_SECURE = 'false';
    jest.resetModules();

    const app = express();
    app.use('/api/auth', require('../src/routes/auth'));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    ({ closeAuthContext } = require('../src/auth'));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeAuthContext();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.AUTH_REQUIRED;
    delete process.env.AUTH_TOKEN_PEPPER;
    delete process.env.AUTH_DB_PATH;
    delete process.env.AUTH_COOKIE_SECURE;
  });

  async function request(url, options = {}) {
    const { headers = {}, ...rest } = options;
    return fetch(origin + '/api/auth' + url, {
      ...rest,
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    });
  }

  test('registers, authenticates, and manages a device', async () => {
    const register = await request('/register', {
      method: 'POST',
      body: JSON.stringify({ email: 'api@example.com', password: 'correct horse battery' }),
    });
    expect(register.status).toBe(201);
    const cookie = register.headers.get('set-cookie').split(';')[0];
    expect(cookie).toMatch(/^nuvio_session=/);

    const me = await request('/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe('api@example.com');

    const create = await request('/devices', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ name: 'Bedroom TV' }),
    });
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.token).toMatch(/^nd_[A-Za-z0-9_-]{22}$/);

    const validDevice = await request('/device/validate', {
      method: 'POST',
      body: JSON.stringify({ token: created.token }),
    });
    expect(validDevice.status).toBe(200);

    const listed = await request('/devices', { headers: { Cookie: cookie } });
    expect((await listed.json()).devices).toEqual([
      expect.objectContaining({ id: created.device.id, name: 'Bedroom TV', revokedAt: null }),
    ]);

    const revoke = await request(`/devices/${created.device.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(revoke.status).toBe(204);
    expect((await request('/device/validate', {
      method: 'POST',
      body: JSON.stringify({ token: created.token }),
    })).status).toBe(403);

    const remove = await request(`/devices/${created.device.id}/permanent`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(remove.status).toBe(204);
    expect((await (await request('/devices', { headers: { Cookie: cookie } })).json()).devices).toEqual([]);

    const logout = await request('/logout', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: '{}',
    });
    expect(logout.status).toBe(204);
    expect((await request('/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  test('rejects a cross-origin mutation', async () => {
    const response = await request('/login', {
      method: 'POST',
      headers: { Origin: 'https://attacker.example' },
      body: JSON.stringify({ email: 'api@example.com', password: 'correct horse battery' }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('origin_forbidden');
  });
});
