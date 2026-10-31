'use strict';

// EXPERIMENTAL. Not wired into the addon. One authenticated, origin-restricted
// CONNECT listener per request. Native-client pooling and real WARP validation remain
// unresolved; do not expose this as an HTTP route or production transport.
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { assertOutboundUrl, OutboundBlockedError } = require('../../src/services/GuardedOutbound');
const { validateNativeProxy, openNativeSocksConnection } = require('../../src/services/NativeSocksConnection');

const MAX_ACTIVE = 8;
let active = 0;

async function withSignal(operation, signal) {
  let abort;
  try {
    signal.throwIfAborted();
    return await Promise.race([operation, new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function createNativeRequestTunnel(targetUrl, options = {}) {
  // The laboratory conservatively applies a configured proxy to every target.
  // Production's provider-specific selection remains a separate integration.
  const proxyValue = options.proxyUrl || process.env.WARP_PROXY_URL || process.env.DAMITV_PROXY_URL;
  const proxy = proxyValue ? validateNativeProxy(proxyValue) : null;
  const target = new URL(targetUrl);
  if (target.protocol !== 'https:') throw new OutboundBlockedError('native_tunnel_https_only');
  if (active >= MAX_ACTIVE) throw Object.assign(new Error('Native tunnel capacity reached'), { code: 'ERR_NATIVE_TUNNEL_CAPACITY' });
  active++;
  const controller = new AbortController();
  const signal = controller.signal;
  const timeoutMs = Math.min(30000, Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000);
  const timer = setTimeout(() => controller.abort(new DOMException('Native tunnel deadline exceeded', 'TimeoutError')), timeoutMs);
  const callerAbort = () => controller.abort(options.signal.reason);
  if (options.signal) options.signal.addEventListener('abort', callerAbort, { once: true });
  let server, starting = false, stopped = false, finish;
  const sockets = new Set();
  const closed = new Promise(resolve => { finish = resolve; });
  const stop = () => {
    if (stopped) return closed;
    stopped = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', callerAbort);
    signal.removeEventListener('abort', stop);
    // SOCKS' handshake listens for errors to clear its authentication timer;
    // closing without the abort reason leaves that timer pending until 5 s.
    for (const socket of sockets) socket.destroy(signal.reason instanceof Error ? signal.reason : undefined);
    let finished = false;
    const done = () => { if (!finished) { finished = true; active--; finish(); } };
    if (server?.listening) server.close(done);
    else if (server && starting) {
      server.once('listening', () => server.close(done));
      server.once('error', done);
    } else done();
    return closed;
  };
  signal.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) callerAbort();
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    if (signal.aborted) socket.destroy(signal.reason instanceof Error ? signal.reason : undefined);
    return socket;
  };
  try {
    await withSignal(assertOutboundUrl(target.href, { resolve: options.resolve }), signal);
    signal.throwIfAborted();
    const password = crypto.randomBytes(24).toString('hex');
    const authorization = Buffer.from('Basic ' + Buffer.from('guard:' + password).toString('base64'));
    const authorize = request => {
      const actual = Buffer.from(request.headers['proxy-authorization'] || '');
      return actual.length === authorization.length && crypto.timingSafeEqual(actual, authorization);
    };
    server = http.createServer({ maxHeaderSize: 8192 }, (_req, res) => {
      res.writeHead(405, { Connection: 'close' }); res.end();
    });
    server.maxConnections = 2;
    server.headersTimeout = Math.min(timeoutMs, 2000);
    server.on('connection', track);
    server.on('connect', async (request, socket, head) => {
      socket.pause();
      if (!authorize(request)) {
        socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="native-request"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      try {
        signal.throwIfAborted();
        const requested = new URL('https://' + request.url);
        if (requested.origin !== target.origin || requested.username || requested.password || requested.pathname !== '/' || requested.search || requested.hash) {
          throw new OutboundBlockedError('native_tunnel_origin');
        }
        // Revalidate at connection creation; dial only the resulting numeric
        // address. resolve/dial injection is a private test seam, never input
        // from an HTTP request or provider metadata.
        const verdict = await withSignal(assertOutboundUrl(target.href, { resolve: options.resolve }), signal);
        signal.throwIfAborted();
        if (socket.destroyed) return;
        const address = { host: verdict.addresses[0], port: Number(target.port || 443) };
        let upstream;
        if (proxy) {
          upstream = await openNativeSocksConnection(address, { proxy, signal, track, withSignal });
        } else {
          const dial = options.dial || net.connect;
          upstream = track(dial(address));
          await withSignal(new Promise((resolve, reject) => {
            upstream.once('connect', resolve); upstream.once('error', reject);
          }), signal);
        }
        if (signal.aborted || socket.destroyed) { upstream.destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
        upstream.once('error', () => socket.destroy());
        socket.once('close', () => upstream.destroy());
        upstream.once('close', () => socket.destroy());
      } catch (_) {
        if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
    starting = true;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    signal.throwIfAborted();
    return {
      proxyUrl: 'http://guard:' + password + '@127.0.0.1:' + server.address().port,
      signal,
      close(reason = new DOMException('Native tunnel closed', 'AbortError')) {
        if (!signal.aborted) controller.abort(reason);
        return stop();
      }
    };
  } catch (error) { await stop(); throw signal.aborted ? signal.reason : error; }
}

module.exports = { createNativeRequestTunnel };
