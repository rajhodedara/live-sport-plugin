'use strict';

// LOCAL INTEGRATION CANDIDATE. One fixed authenticated HTTP/CONNECT endpoint and native client per slot.
// Callback operations must await the complete body without passing a caller
// signal to Impit. Not imported by the addon; not a public relay route.
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { assertOutboundUrl, OutboundBlockedError } = require('./GuardedOutbound');
const { createNativeExclusiveSlot } = require('./NativeExclusiveSlot');
const { validateNativeProxy, openNativeSocksConnection } = require('./NativeSocksConnection');
const MAX_SLOTS = 4;
let slots = 0;

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

async function createNativeGuardedSlot(options = {}) {
  const proxyValue = Object.hasOwn(options, 'proxyUrl') ? options.proxyUrl :
    process.env.WARP_PROXY_URL || process.env.DAMITV_PROXY_URL;
  const proxy = proxyValue ? validateNativeProxy(proxyValue) : null;
  if (slots >= MAX_SLOTS) throw Object.assign(new Error('Native laboratory slot capacity'), { code: 'ERR_NATIVE_SLOT_CAPACITY', slotCount: slots, slotLimit: MAX_SLOTS });
  slots++;
  let lease = null, closed = false, closing, client;
  const accepted = new WeakMap(), connections = new Set();
  const password = crypto.randomBytes(24).toString('hex');
  const authorization = Buffer.from('Basic ' + Buffer.from('guard:' + password).toString('base64'));
  const authorize = request => {
    const value = Buffer.from(request.headers['proxy-authorization'] || '');
    return value.length === authorization.length && crypto.timingSafeEqual(value, authorization);
  };
  const transportHeaders = headers => {
    const blocked = new Set(['host', 'connection', 'proxy-connection', 'proxy-authorization',
      'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
    for (const token of String(headers.connection || '').split(',')) blocked.add(token.trim().toLowerCase());
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !blocked.has(name.toLowerCase())));
  };
  const server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const current = accepted.get(request.socket);
    if (!current || current !== lease || current.controller.signal.aborted || closed) { response.destroy(); return; }
    if (!authorize(request)) { response.writeHead(407, { Connection: 'close' }); response.end(); return; }
    request.pause();
    const peer = new AbortController();
    response.once('close', () => peer.abort(new DOMException('Native HTTP peer closed', 'AbortError')));
    const signal = AbortSignal.any([current.controller.signal, peer.signal]);
    const task = (async () => {
      try {
        const target = new URL(request.url);
        if (target.protocol !== 'http:' || target.href !== current.target.href) throw new OutboundBlockedError('native_slot_origin');
        const socket = await openConnection(current, signal);
        signal.throwIfAborted();
        if (current !== lease || response.destroyed) { socket.destroy(); return; }
        const headers = transportHeaders(request.headers);
        delete headers['content-length'];
        // A dedicated Agent must use only the already validated socket. Do
        // not let http.request perform a second, independent hostname dial.
        const agent = new http.Agent({ keepAlive: false });
        agent.createConnection = (_options, callback) => { callback(null, socket); };
        const upstream = http.request({ hostname: target.hostname, port: target.port || 80,
          method: request.method, path: target.pathname + target.search,
          headers: { ...headers, host: target.host, connection: 'close' },
          agent }, received => {
          response.writeHead(received.statusCode, { ...transportHeaders(received.headers), Connection: 'close' });
          received.on('error', error => response.destroy(error));
          received.pipe(response);
        });
        upstream.once('close', () => agent.destroy());
        upstream.on('error', error => response.destroy(error));
        request.on('error', error => upstream.destroy(error));
        request.pipe(upstream); request.resume();
      } catch (error) {
        if (error.code === 'ERR_OUTBOUND_BLOCKED') current.guardError = error;
        if (!response.headersSent) { response.writeHead(403, { Connection: 'close' }); response.end(); }
        else response.destroy();
      }
    })().finally(() => current.tasks.delete(task));
    current.tasks.add(task);
  });
  server.maxConnections = 2;
  server.headersTimeout = 2000;
  const track = (current, socket) => {
    current.sockets.add(socket); connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { current.sockets.delete(socket); connections.delete(socket); });
    if (current.controller.signal.aborted) socket.destroy(current.controller.signal.reason);
    return socket;
  };
  const openConnection = async (current, signal) => {
    const verdict = await withSignal(assertOutboundUrl(current.target.href, { resolve: options.resolve }), signal);
    signal.throwIfAborted();
    if (current !== lease) throw new DOMException('Native lease changed', 'AbortError');
    const address = { host: verdict.addresses[0], port: Number(current.target.port || (current.target.protocol === 'https:' ? 443 : 80)) };
    const own = upstream => {
      track(current, upstream);
      const stop = () => upstream.destroy(signal.reason instanceof Error ? signal.reason : undefined);
      signal.addEventListener('abort', stop, { once: true });
      upstream.once('close', () => signal.removeEventListener('abort', stop));
      if (signal.aborted) stop();
      return upstream;
    };
    if (proxy) return openNativeSocksConnection(address, { proxy, signal, track: own, withSignal });
    const upstream = own((options.dial || net.connect)(address));
    await withSignal(new Promise((resolve, reject) => {
      upstream.once('connect', resolve); upstream.once('error', reject);
    }), signal);
    return upstream;
  };
  server.on('connection', socket => {
    // Bind at accept time, so a previously accepted idle connection cannot
    // acquire authority from the next request's lease when its headers arrive.
    const current = lease;
    if (!current || current.controller.signal.aborted || closed) { socket.destroy(); return; }
    accepted.set(socket, current); track(current, socket);
  });
  server.on('connect', (request, socket, head) => {
    const current = accepted.get(socket);
    socket.pause();
    if (!current || current !== lease || current.controller.signal.aborted || closed) { socket.destroy(); return; }
    if (!authorize(request)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return;
    }
    const peer = new AbortController();
    const peerClosed = () => peer.abort(new DOMException('Native peer closed', 'AbortError'));
    socket.once('close', peerClosed);
    const signal = AbortSignal.any([current.controller.signal, peer.signal]);
    const task = (async () => {
      try {
        const requested = new URL('https://' + request.url);
        if (requested.origin !== current.target.origin || requested.username || requested.password || requested.pathname !== '/' || requested.search || requested.hash) {
          throw new OutboundBlockedError('native_slot_origin');
        }
        const upstream = await openConnection(current, signal);
        signal.throwIfAborted();
        if (current !== lease || socket.destroyed) { upstream.destroy(); return; }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket); socket.resume();
        upstream.once('close', () => socket.destroy());
        upstream.once('error', () => socket.destroy());
      } catch (error) {
        if (error.code === 'ERR_OUTBOUND_BLOCKED') current.guardError = error;
        if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    })().finally(() => current.tasks.delete(task));
    current.tasks.add(task);
  });
  const cancelLease = reason => {
    if (!lease) return;
    const failure = reason || new DOMException('Native lease finished', 'AbortError');
    if (!lease.controller.signal.aborted) lease.controller.abort(failure);
    for (const socket of lease.sockets) socket.destroy(failure instanceof Error ? failure : undefined);
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    let nativeModule;
    try { nativeModule = options.nativeModule || require('impit'); }
    catch (cause) { throw Object.assign(new Error('Native guarded transport unavailable', { cause }), { code: 'ERR_NATIVE_UNAVAILABLE' }); }
    const { Impit } = nativeModule;
    if (options.profile && !['chrome', 'vanilla'].includes(options.profile)) throw new TypeError('Invalid native laboratory profile');
    client = new Impit({ ...(options.profile === 'vanilla' ? {} : { browser: 'chrome142' }), http3: false, followRedirects: false,
      ignoreTlsErrors: false, timeout: 15000,
      proxyUrl: 'http://guard:' + password + '@127.0.0.1:' + server.address().port });
    const exclusive = createNativeExclusiveSlot(client, cancelLease);
    return {
      get busy() { return exclusive.busy; },
      whenIdle() { return exclusive.whenIdle(); },
      run(targetUrl, operation, runOptions = {}) {
        if (closed) return Promise.reject(Object.assign(new Error('Native slot closed'), { code: 'ERR_NATIVE_SLOT_CLOSED' }));
        return exclusive.run(async (native, operationSignal) => {
          if (closed) throw Object.assign(new Error('Native slot closed'), { code: 'ERR_NATIVE_SLOT_CLOSED' });
          const target = new URL(targetUrl);
          if (!['http:', 'https:'].includes(target.protocol)) throw new OutboundBlockedError('native_slot_protocol');
          target.hash = '';
          const current = { target, controller: new AbortController(), sockets: new Set(), tasks: new Set() };
          lease = current;
          try {
            await withSignal(assertOutboundUrl(target.href, { resolve: options.resolve }), current.controller.signal);
            try {
              const value = await operation(native, operationSignal);
              if (current.guardError) throw current.guardError;
              return value;
            } catch (error) { throw current.guardError || error; }
          } finally {
            cancelLease();
            await Promise.allSettled([...current.tasks]);
            await Promise.all([...current.sockets].filter(socket => !socket.closed).map(socket =>
              new Promise(resolve => socket.once('close', resolve))));
            if (lease === current) lease = null;
          }
        }, runOptions);
      },
      close() {
        if (closing) return closing;
        closed = true; cancelLease(new DOMException('Native slot shutdown', 'AbortError'));
        closing = (async () => {
          await exclusive.whenIdle();
          exclusive.dispose();
          for (const socket of connections) socket.destroy();
          await new Promise(resolve => server.close(resolve));
          client = null; slots--;
        })();
        return closing;
      }
    };
  } catch (error) {
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    slots--; throw error;
  }
}

module.exports = { createNativeGuardedSlot };
