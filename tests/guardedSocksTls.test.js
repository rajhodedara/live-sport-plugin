'use strict';
// A synthetic SOCKS server terminates TLS itself: it never forwards to the
// requested address. Separate Node children isolate the fixture trust store.
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fixture = path.join(__dirname, 'fixtures/guarded-tls');
const context = tls.createSecureContext({
  key: fs.readFileSync(path.join(fixture, 'key.pem')),
  cert: fs.readFileSync(path.join(fixture, 'cert.pem'))
});

describe('guarded SOCKS HTTPS identity', () => {
  let server, proxyUrl;
  const sockets = new Set(), destinations = [], servernames = [], requests = [];
  beforeAll(async () => {
    server = net.createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let bytes = Buffer.alloc(0), state = 'greeting';
      const receive = chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (state === 'greeting') {
          if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return;
          bytes = bytes.subarray(2 + bytes[1]);
          socket.write(Buffer.from([5, 0]));
          state = 'connect';
        }
        if (state !== 'connect' || bytes.length < 10) return;
        if (bytes[3] !== 1) { socket.destroy(); return; }
        destinations.push([...bytes.subarray(4, 8)].join('.'));
        socket.removeListener('data', receive);
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        const secured = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
        secured.on('error', () => {});
        secured.once('secure', () => servernames.push(secured.servername));
        let http = '';
        secured.on('data', data => {
          http += data.toString('utf8');
          if (!http.includes('\r\n\r\n')) return;
          requests.push(http);
          secured.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture');
        });
        state = 'tls';
      };
      socket.on('data', receive);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    proxyUrl = 'socks5://127.0.0.1:' + server.address().port;
  });
  beforeEach(() => { destinations.length = 0; servernames.length = 0; requests.length = 0; });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });

  function fetchInChild(hostname, trust) {
    const source = `
      const dns = require('node:dns');
      dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      const { guardedFetch, closeGuardedDispatcher } = require(${JSON.stringify(require.resolve('../src/services/GuardedOutbound'))});
      (async () => {
        try {
          const response = await guardedFetch('https://' + process.argv[1] + '/playlist', {
            proxyUrl: process.argv[2], timeoutMs: 2000
          });
          process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: error.code, name: error.name }));
        } finally { await closeGuardedDispatcher(); }
      })().catch(() => { process.exitCode = 1; });
    `;
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      delete env.NODE_EXTRA_CA_CERTS;
      delete env.NODE_OPTIONS;
      if (trust) env.NODE_EXTRA_CA_CERTS = path.join(fixture, 'cert.pem');
      const child = spawn(process.execPath, ['-e', source, hostname, proxyUrl], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Local TLS fixture child did not exit')); }, 4000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0) { reject(new Error('TLS fixture child failed: ' + stderr)); return; }
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    });
  }

  test('numeric SOCKS pinning preserves original HTTPS SNI, certificate verification and Host', async () => {
    await expect(fetchInChild('cdn.example.org', true)).resolves.toEqual({ status: 200, body: 'fixture' });
    expect(destinations).toEqual(['93.184.216.34']);
    expect(servernames).toEqual(['cdn.example.org']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatch(/host: cdn\.example\.org\r\n/i);
  });

  test('a trusted certificate for a different hostname is rejected before HTTP', async () => {
    await expect(fetchInChild('other.example.org', true)).resolves.toMatchObject({ error: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    expect(destinations).toEqual(['93.184.216.34']);
    expect(requests).toHaveLength(0);
  });

  test('an untrusted certificate is rejected before HTTP', async () => {
    await expect(fetchInChild('cdn.example.org', false)).resolves.toMatchObject({ error: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(destinations).toEqual(['93.184.216.34']);
    expect(requests).toHaveLength(0);
  });
});
