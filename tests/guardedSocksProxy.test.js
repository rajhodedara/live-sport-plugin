'use strict';
const net = require('node:net');
const dns = require('node:dns');
const { spawn } = require('node:child_process');
const { guardedFetch, closeGuardedDispatcher } = require('../src/services/GuardedOutbound');

describe('guarded WARP/SOCKS5 transport', () => {
  let proxy, proxyUrl, lookup, connects, silent, holdHttp;
  const replies = [];
  const destinations = [], requests = [], sockets = new Set();
  const originalWarp = process.env.WARP_PROXY_URL;
  beforeAll(async () => {
    proxy = net.createServer(socket => {
      connects++; sockets.add(socket);
      const stalled = silent, hold = holdHttp;
      socket.on('close', () => sockets.delete(socket));
      let bytes = Buffer.alloc(0), state = 'greeting';
      socket.on('data', chunk => {
        if (stalled) return;
        bytes = Buffer.concat([bytes, chunk]);
        if (state === 'greeting') {
          if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return;
          bytes = bytes.subarray(2 + bytes[1]);
          socket.write(Buffer.from([5, 0])); state = 'connect';
        }
        if (state === 'connect') {
          if (bytes.length < 4) return;
          const atyp = bytes[3];
          const size = atyp === 1 ? 10 : atyp === 4 ? 22 : bytes.length >= 5 ? 7 + bytes[4] : Infinity;
          if (bytes.length < size) return;
          destinations.push({ atyp, address: atyp === 1 ? [...bytes.subarray(4, 8)].join('.') : 'non-ipv4' });
          bytes = bytes.subarray(size);
          // The fixture does not connect to the requested destination. It
          // supplies synthetic HTTP after recording the SOCKS CONNECT bytes.
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); state = 'http';
        }
        if (state === 'http' && bytes.includes(Buffer.from('\r\n\r\n'))) {
          requests.push(bytes.toString('utf8'));
          const reply = () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture');
          if (hold) replies.push(reply); else reply();
          state = 'done';
        }
      });
      socket.on('error', () => {});
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    proxyUrl = 'socks5://127.0.0.1:' + proxy.address().port;
  });
  beforeEach(() => {
    connects = 0; silent = false; holdHttp = false; replies.length = 0; destinations.length = 0; requests.length = 0;
    lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(async () => {
    lookup.mockRestore();
    if (originalWarp === undefined) delete process.env.WARP_PROXY_URL;
    else process.env.WARP_PROXY_URL = originalWarp;
    await closeGuardedDispatcher();
  });
  afterAll(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });

  test('production WARP selection is preserved and the proxy receives the validated numeric address', async () => {
    process.env.WARP_PROXY_URL = proxyUrl;
    // Keep native Impit's CustomGC handles outside Jest's VM. The parent's
    // SOCKS fixture remains live, but the actual safeFetch/native client and
    // teardown execute in a fresh child process as in the TLS/native suites.
    const source = `
      require('node:dns').promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
      const { safeFetch } = require(process.argv[1]);
      const { closeGuardedDispatcher } = require(process.argv[2]);
      (async () => {
        try {
          const response = await safeFetch('http://messi.damitv.st/playlist', { guardExternal: true, timeoutMs: 1500 });
          process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));
        } finally { await closeGuardedDispatcher(); }
      })().catch(error => { process.stderr.write(error.name + ':' + error.code); process.exitCode = 1; });
    `;
    const response = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', source, require.resolve('../src/impitClient'), require.resolve('../src/services/GuardedOutbound')], {
        env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '', errors = '';
      const timer = setTimeout(() => { child.kill(); reject(Error('Native WARP fixture did not exit')); }, 4000);
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
      child.once('error', failure => { clearTimeout(timer); reject(failure); });
      child.once('close', code => {
        clearTimeout(timer);
        if (code !== 0) { reject(Error('Native WARP fixture failed: ' + errors)); return; }
        try { resolve(JSON.parse(output)); } catch (failure) { reject(failure); }
      });
    });
    expect(response).toEqual({ status: 200, body: 'fixture' });
    expect(connects).toBe(1);
    expect(destinations).toEqual([{ atyp: 1, address: '93.184.216.34' }]);
    expect(requests[0]).toMatch(/host: messi\.damitv\.st/i);
  });

  test('DNS rebinding at tunnel creation is blocked before contacting the proxy', async () => {
    lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(guardedFetch('http://cdn.example.org/playlist', { proxyUrl, timeoutMs: 1500 })).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
    expect(connects).toBe(0);
    expect(destinations).toHaveLength(0);
  });

  test('unsupported configured proxies fail closed rather than silently connecting directly', async () => {
    await expect(guardedFetch('http://cdn.example.org/playlist', { proxyUrl: 'http://127.0.0.1:8888' })).rejects.toMatchObject({ reason: 'unsupported_guarded_proxy' });
    expect(connects).toBe(0);
  });

  test('deadline closes a proxy that accepts TCP but never completes the SOCKS greeting', async () => {
    silent = true;
    const failure = guardedFetch('http://cdn.example.org/stall', { proxyUrl, timeoutMs: 100 }).catch(error => error);
    expect(await failure).toMatchObject({ name: 'TimeoutError' });
    expect(connects).toBe(1);
    const end = Date.now() + 800;
    while (sockets.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
    // Destroy leftovers even on baseline failure so the test does not hang.
    const remaining = sockets.size;
    for (const socket of sockets) socket.destroy();
    expect(remaining).toBe(0);
  });

  test('canceling a stalled greeting preserves another in-flight request through the same proxy', async () => {
    const waitFor = async predicate => {
      const end = Date.now() + 1500;
      while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
      expect(predicate()).toBe(true);
    };
    silent = true;
    const controller = new AbortController(), reason = new Error('viewer stopped');
    const first = guardedFetch('http://cdn.example.org/stalled', { proxyUrl, signal: controller.signal, timeoutMs: 2000 }).catch(error => error);
    await waitFor(() => connects === 1);
    silent = false; holdHttp = true;
    const second = guardedFetch('http://cdn.example.org/healthy', { proxyUrl, timeoutMs: 2000 });
    await waitFor(() => replies.length === 1);
    controller.abort(reason);
    expect(await first).toBe(reason);
    replies[0]();
    expect(await (await second).text()).toBe('fixture');
    await waitFor(() => sockets.size === 0);
  });
});
