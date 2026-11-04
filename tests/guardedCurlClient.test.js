'use strict';

// Pure child-process fixtures: no curl process, native module, socket or listener.
const { EventEmitter } = require('node:events');
const { createGuardedCurlModule } = require('../src/services/GuardedCurlClient');
const proxyUrl = 'http://guard:fixture-secret@127.0.0.1:41001/';
const target = 'https://damitv.st/c/123.m3u8?tk=fixture';
const opts = extra => ({ redirect: 'manual', timeout: 1000, maxBodyBytes: 64, ...extra });

function fixture() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = jest.fn(() => true);
  const spawnProcess = jest.fn(() => child);
  const { Impit } = createGuardedCurlModule({ spawnProcess });
  const client = new Impit({ proxyUrl });
  return { child, spawnProcess, client,
    output: value => child.stdout.emit('data', Buffer.from(value)),
    close: (code = 0) => child.emit('close', code) };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('pins curl to the guarded proxy, ignores config/proxy bypass env and retains TLS verification', async () => {
  const f = fixture(), response = f.client.fetch(target, opts({ headers: { Referer: 'https://damitv.st/' } }));
  const [command, args, options] = f.spawnProcess.mock.calls[0];
  expect(command).toBe('curl'); expect(args[0]).toBe('--disable');
  expect(args.slice(args.indexOf('--proxy'), args.indexOf('--proxy') + 2)).toEqual(['--proxy', proxyUrl]);
  expect(args.slice(args.indexOf('--noproxy'), args.indexOf('--noproxy') + 2)).toEqual(['--noproxy', '']);
  expect(args).toContain('--suppress-connect-headers'); expect(args).toContain('=http,https');
  expect(args).toContain('--globoff');
  expect(args).toContain('referer: https://damitv.st/');
  expect(args).not.toEqual(expect.arrayContaining(['--location']));
  expect(args.some(arg => ['--insecure', '-k', '--proxy-insecure', '--socks5-hostname'].includes(arg))).toBe(false);
  expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  f.output('HTTP/2 200\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n#EXTM3U\n'); f.close();
  const r = await response;
  expect(r.status).toBe(200); expect(await new Response(r.body).text()).toBe('#EXTM3U\n');
});

test('passes brace and bracket query values literally rather than expanding curl URL globs', async () => {
  const f = fixture(), url = 'https://damitv.st/c/live.m3u8?tk={one,two}&v=[1-3]';
  const response = f.client.fetch(url, opts());
  const args = f.spawnProcess.mock.calls[0][1];
  expect(args).toContain('--globoff'); expect(args.slice(-2)).toEqual(['--url', url]);
  f.output('HTTP/2 200\r\n\r\nfixture'); f.close();
  expect(await new Response((await response).body).text()).toBe('fixture');
});

test('handles split interim headers and does not reparse a body that starts HTTP/', async () => {
  const f = fixture(), response = f.client.fetch(target, opts());
  f.output('HTTP/1.1 100 Continue\r\n\r\nHTTP/2 103 Early Hints\r\nLink: fixture\r\n\r');
  f.output('\nHTTP/2 200\r\nX-Test: yes\r\n\r\nHTTP/1.1 404\r\n\r\nbinary'); f.close();
  const r = await response;
  expect(r.status).toBe(200); expect(r.headers.get('x-test')).toBe('yes');
  expect(r.headers.get('link')).toBe(null);
  expect(await new Response(r.body).text()).toBe('HTTP/1.1 404\r\n\r\nbinary');
});

test('HEAD uses curl --head and returns after headers without waiting for a declared body', async () => {
  const f = fixture(), response = f.client.fetch(target, opts({ method: 'HEAD' }));
  expect(f.spawnProcess.mock.calls[0][1]).toContain('--head');
  f.output('HTTP/1.1 200 OK\r\nContent-Length: 9999999\r\n\r\n');
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'); f.close(null);
  expect(await new Response((await response).body).text()).toBe('');
});

test('caps body to the requested prefix plus a truncation sentinel and waits for child close', async () => {
  const f = fixture(); let settled = false;
  const response = f.client.fetch(target, opts({ maxBodyBytes: 4 })).then(value => { settled = true; return value; });
  f.output('HTTP/1.1 200 OK\r\n\r\n'); f.output('123456789');
  f.output('further output is ignored');
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
  await turn(); expect(settled).toBe(false);
  f.close(null);
  expect(await new Response((await response).body).text()).toBe('12345');
});

test('a body exactly at the limit is complete and does not kill curl', async () => {
  const f = fixture(), response = f.client.fetch(target, opts({ maxBodyBytes: 4 }));
  f.output('HTTP/1.1 200 OK\r\n\r\n1234'); f.close();
  expect(await new Response((await response).body).text()).toBe('1234');
  expect(f.child.kill).not.toHaveBeenCalled();
});

test('returns redirects without consuming an unbounded redirect body', async () => {
  const f = fixture(), response = f.client.fetch(target, opts());
  f.output('HTTP/2 302\r\nLocation: https://cdn.example.org/live.m3u8\r\n\r\n');
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'); f.close(null);
  const r = await response;
  expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('https://cdn.example.org/live.m3u8');
  expect(await new Response(r.body).text()).toBe('');
});

test.each([
  ['headers', f => f.output('HTTP/1.1 200 OK\r\nX-Test: ' + 'x'.repeat(65536)), 'ERR_GUARDED_CURL_HEADER_LIMIT'],
  ['stderr', f => f.child.stderr.emit('data', Buffer.alloc(8193)), 'ERR_GUARDED_CURL_STDERR_LIMIT'],
  ['status', f => f.output('not an HTTP response\r\n\r\n'), 'ERR_GUARDED_CURL_HEADERS'],
  ['upgrade', f => f.output('HTTP/1.1 101 Switching Protocols\r\n\r\n'), 'ERR_GUARDED_CURL_HEADERS'],
  ['folded headers', f => f.output('HTTP/1.1 200 OK\r\n X-Test: bad\r\n\r\n'), 'ERR_GUARDED_CURL_HEADERS']
])('bounds or rejects %s without releasing the child early', async (_name, produce, code) => {
  const f = fixture(), response = f.client.fetch(target, opts());
  const check = expect(response).rejects.toMatchObject({ code, isFatal: true });
  produce(f); expect(f.child.kill).toHaveBeenCalledWith('SIGTERM'); f.close(null);
  await check;
});

test('an already aborted operation never starts a process', async () => {
  const f = fixture(), controller = new AbortController(), reason = new Error('fixture cancelled');
  controller.abort(reason);
  await expect(f.client.fetch(target, opts({ signal: controller.signal }))).rejects.toBe(reason);
  expect(f.spawnProcess).not.toHaveBeenCalled();
});

test('abort retains ownership until close and escalates a child that ignores SIGTERM', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(), controller = new AbortController(), reason = new Error('fixture cancelled');
    let settled = false;
    const response = f.client.fetch(target, opts({ signal: controller.signal })).catch(error => { settled = true; throw error; });
    const check = expect(response).rejects.toBe(reason);
    controller.abort(reason); await Promise.resolve(); expect(settled).toBe(false);
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(250); expect(f.child.kill).toHaveBeenLastCalledWith('SIGKILL');
    expect(settled).toBe(false); f.close(null); await check;
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test.each(['headers', 'body'])('deadline during %s kills and waits for close', async phase => {
  jest.useFakeTimers();
  try {
    const f = fixture(), response = f.client.fetch(target, opts({ timeout: 20 }));
    const check = expect(response).rejects.toMatchObject({ name: 'TimeoutError' });
    if (phase === 'body') f.output('HTTP/1.1 200 OK\r\n\r\npartial');
    jest.advanceTimersByTime(20); expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');
    f.close(null); await check; expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('spawn failures and failed partial transfers never publish a successful response', async () => {
  const f = fixture(), response = f.client.fetch(target, opts());
  const check = expect(response).rejects.toMatchObject({ code: 'ERR_GUARDED_CURL_UNAVAILABLE' });
  f.child.emit('error', new Error('secret should not be returned')); f.close(-2); await check;
  const partial = fixture(), transfer = partial.client.fetch(target, opts());
  const transferCheck = expect(transfer).rejects.toMatchObject({ code: 'ERR_GUARDED_CURL_FETCH' });
  partial.output('HTTP/1.1 200 OK\r\n\r\npartial'); partial.close(56); await transferCheck;
});

test('constructor refuses external or unauthenticated proxy endpoints', () => {
  const { Impit } = createGuardedCurlModule({ spawnProcess: jest.fn() });
  for (const value of ['socks5://127.0.0.1:1080', 'http://127.0.0.1:41001', 'http://guard:x@external.example:80', 'http://guard:x@127.0.0.1:41001/other']) {
    expect(() => new Impit({ proxyUrl: value })).toThrow('owned guarded loopback proxy');
  }
});
