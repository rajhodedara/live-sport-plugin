'use strict';
// Real HTTP/Undici body cancellation against a trusted local fixture. Only the
// TCP connector is substituted here; DNS rejection has its own real-connector
// tests in guardedOutbound.test.js. This hook is not a production URL option.
let mockPort;
jest.mock('undici', () => {
  const actual = jest.requireActual('undici');
  const net = require('node:net');
  return { ...actual, Agent: class {
    constructor() {
      return new actual.Agent({ connect: (_options, callback) => {
        const onError = error => callback(error);
        const socket = net.connect(mockPort, '127.0.0.1', () => {
          socket.removeListener('error', onError);
          callback(null, socket);
        });
        socket.once('error', onError);
      } });
    }
  } };
});
const http = require('node:http');
const dns = require('node:dns');
const { guardedFetch, closeGuardedDispatcher } = require('../src/services/GuardedOutbound');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('guarded transport total deadline over real HTTP', () => {
  let server, lookup;
  const seen = new Set(), closed = new Set();
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.add(req.url);
      if (req.url === '/redirect') {
        const timer = setTimeout(() => { res.writeHead(302, { Location: '/body' }); res.end(); }, 30);
        res.on('close', () => clearTimeout(timer));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.flushHeaders();
        const timer = setInterval(() => res.write('x'), 10);
        res.on('close', () => clearInterval(timer));
      }
      res.on('close', () => closed.add(req.url));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    mockPort = server.address().port;
  });
  beforeEach(() => {
    seen.clear(); closed.clear();
    lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });
  afterEach(async () => { lookup.mockRestore(); await closeGuardedDispatcher(); });
  afterAll(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

  async function waitFor(predicate) {
    const end = Date.now() + 1500;
    while (!predicate() && Date.now() < end) await pause(5);
    expect(predicate()).toBe(true);
  }

  test('continuous body traffic cannot extend the total deadline', async () => {
    const start = Date.now();
    await expect(guardedFetch('http://cdn.example.org/body', { timeoutMs: 100 })).rejects.toBeDefined();
    expect(Date.now() - start).toBeLessThan(1200);
    expect(seen.has('/body')).toBe(true);
    await waitFor(() => closed.has('/body'));
  });

  test('redirect and final body consume one deadline', async () => {
    await expect(guardedFetch('http://cdn.example.org/redirect', { timeoutMs: 150 })).rejects.toBeDefined();
    expect(seen.has('/redirect')).toBe(true);
    expect(seen.has('/body')).toBe(true);
    await waitFor(() => closed.has('/body'));
  });

  test('caller cancellation during the body keeps its reason and closes the connection', async () => {
    const controller = new AbortController(), reason = new Error('viewer disconnected');
    const pending = guardedFetch('http://cdn.example.org/abort', { signal: controller.signal, timeoutMs: 1500 });
    const done = pending.catch(error => error);
    await waitFor(() => seen.has('/abort'));
    controller.abort(reason);
    expect(await done).toBe(reason);
    await waitFor(() => closed.has('/abort'));
  });

  test('a stalled DNS lookup respects the deadline without opening HTTP', async () => {
    lookup.mockImplementation(() => new Promise(() => {}));
    const start = Date.now();
    await expect(guardedFetch('http://cdn.example.org/dns', { timeoutMs: 70 })).rejects.toBeDefined();
    expect(Date.now() - start).toBeLessThan(1200);
    expect(seen.size).toBe(0);
  });
});
