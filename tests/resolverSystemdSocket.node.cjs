'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('systemd socket activation is opt-in and validates the target process and count', async () => {
  const { systemdSocketFd } = await import('../resolver/src/systemdSocket.js');
  assert.equal(systemdSocketFd({}, 123), null);
  assert.equal(systemdSocketFd({ RESOLVER_SYSTEMD_SOCKET: 'false', LISTEN_PID: '123', LISTEN_FDS: '1' }, 123), null);
  assert.equal(systemdSocketFd({ RESOLVER_SYSTEMD_SOCKET: 'true', LISTEN_PID: '123', LISTEN_FDS: '1' }, 123), 3);
  for (const env of [
    { RESOLVER_SYSTEMD_SOCKET: 'true' },
    { RESOLVER_SYSTEMD_SOCKET: 'true', LISTEN_PID: '999', LISTEN_FDS: '1' },
    { RESOLVER_SYSTEMD_SOCKET: 'true', LISTEN_PID: '123', LISTEN_FDS: '2' },
    { RESOLVER_SYSTEMD_SOCKET: 'true', LISTEN_PID: '123', LISTEN_FDS: '0' }
  ]) assert.throws(() => systemdSocketFd(env, 123), /Invalid resolver socket activation/);
});

test('TLS credentials require explicit socket activation and fail without fallback', async () => {
  const { systemdTlsOptions } = await import('../resolver/src/systemdTls.js');
  assert.equal(systemdTlsOptions({}, null), null);
  const env = { RESOLVER_SYSTEMD_TLS: 'true', CREDENTIALS_DIRECTORY: '/run/credentials/fixture' };
  assert.throws(() => systemdTlsOptions(env, null), /Invalid resolver TLS/);
  assert.throws(() => systemdTlsOptions({ ...env, CREDENTIALS_DIRECTORY: '/run/a/../b' }, 3), /Invalid resolver TLS/);
  const seen = [];
  const options = systemdTlsOptions(env, 3, file => { seen.push(file); return Buffer.from('fixture'); });
  assert.deepEqual(seen, ['/run/credentials/fixture/resolver.crt', '/run/credentials/fixture/resolver.key']);
  assert.ok(Buffer.isBuffer(options.cert)); assert.ok(Buffer.isBuffer(options.key));
  assert.throws(() => systemdTlsOptions(env, 3, () => { throw new Error('sensitive path'); }), error =>
    error.message === 'Resolver TLS credentials unavailable');
  assert.throws(() => systemdTlsOptions(env, 3, () => Buffer.alloc(65537)), /credentials unavailable/);
});

test('credential options construct an HTTPS server using the test certificate', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const https = require('node:https');
  const { systemdTlsOptions } = await import('../resolver/src/systemdTls.js');
  const fixture = path.join(__dirname, 'fixtures/guarded-tls');
  const options = systemdTlsOptions({ RESOLVER_SYSTEMD_TLS: 'true', CREDENTIALS_DIRECTORY: '/run/credentials/fixture' }, 3,
    file => fs.readFileSync(path.join(fixture, file.endsWith('resolver.crt') ? 'cert.pem' : 'key.pem')));
  const server = https.createServer(options, (_req, res) => res.end('ok'));
  assert.equal(typeof server.listen, 'function');
  server.close();
});
