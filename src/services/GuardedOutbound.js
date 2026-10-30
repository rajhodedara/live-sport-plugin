'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { Agent, Socks5ProxyAgent, buildConnector, request } = require('undici');
const { checkOutboundUrl } = require('./OutboundUrlGuard');
const { filterRedirectHeaders, shouldDropRedirectBody } = require('./RedirectHeaderPolicy');

class OutboundBlockedError extends Error {
  constructor(reason) {
    super(`Blocked outbound request: ${reason}`);
    this.name = 'OutboundBlockedError';
    this.code = 'ERR_OUTBOUND_BLOCKED';
    this.statusCode = 403;
    this.reason = reason;
    this.isFatal = true;
  }
}

const resolveAll = async hostname => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map(record => record.address);

async function assertOutboundUrl(url, options) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { throw new OutboundBlockedError('invalid_url'); }
  if (parsed.username || parsed.password) throw new OutboundBlockedError('url_credentials');
  const verdict = await checkOutboundUrl(url, options);
  if (!verdict.ok) throw new OutboundBlockedError(verdict.reason);
  return verdict;
}

// Validate the records returned to the socket connector itself. A separate
// preflight DNS lookup is not enough: its answer can change before connection.
// Injection is for internal tests, never an option taken from an HTTP request.
function createGuardedLookup({ resolve = resolveAll, allowedHosts } = {}) {
  return (hostname, options, callback) => {
    const host = String(hostname).replace(/\.$/, '');
    if (net.isIP(host)) {
      // Undici normally skips lookup for literals; URL validation is also
      // mandatory before handing the request to the dispatcher.
      assertOutboundUrl(`https://${net.isIP(host) === 6 ? `[${host}]` : host}/`, { resolve, allowedHosts })
        .then(verdict => finish(verdict.addresses), callback);
      return;
    }
    assertOutboundUrl(`https://${host}/`, { resolve, allowedHosts })
      .then(verdict => finish(verdict.addresses), callback);

    function finish(addresses) {
      const family = typeof options === 'number' ? options : options && options.family;
      const records = addresses.map(address => ({ address, family: net.isIP(address) }))
        .filter(record => !family || record.family === family);
      if (!records.length || records.some(record => !record.family)) {
        callback(new OutboundBlockedError('invalid_dns_answer'));
      } else if (options && options.all) {
        callback(null, records);
      } else {
        callback(null, records[0].address, records[0].family);
      }
    }
  };
}

function createGuardedDispatcher(options) {
  return new Agent({ connect: { lookup: createGuardedLookup(options) } });
}

let dispatcher;
const proxyDispatchers = new Set();
const MAX_PROXY_REQUESTS = 32;

// Undici 8.10's SOCKS adapter normally sends the hostname to the proxy.
// Validate at tunnel creation and send a numeric address instead, while its
// origin pool retains the original Host and TLS servername. This hook is
// version-sensitive and is covered by real SOCKS handshake regressions.
class GuardedSocksDispatcher extends Socks5ProxyAgent {
  constructor(proxy, signal) {
    const sockets = new Set();
    const connect = buildConnector({});
    super(proxy, { connect: (options, callback) => {
      if (signal.aborted) { callback(signal.reason); return; }
      const socket = connect(options, (error, connected) => {
        if (signal.aborted) { connected?.destroy(); callback(signal.reason); }
        else callback(error, connected);
      });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      if (signal.aborted) socket.destroy(signal.reason);
    } });
    this.guardSignal = signal;
    this.guardSockets = sockets;
    this.guardAbort = () => { for (const socket of sockets) socket.destroy(signal.reason); };
    signal.addEventListener('abort', this.guardAbort, { once: true });
    if (signal.aborted) this.guardAbort();
  }

  release() {
    this.guardSignal.removeEventListener('abort', this.guardAbort);
    for (const socket of this.guardSockets) socket.destroy();
    return this.destroy();
  }

  async createSocks5Connection(hostname, port) {
    const host = hostname.replace(/^\[|\]$/g, '');
    const verdict = await checkWithSignal(`https://${net.isIP(host) === 6 ? `[${host}]` : host}/`, this.guardSignal);
    return super.createSocks5Connection(verdict.addresses[0], port);
  }
}

function proxyDispatcher(rawUrl, signal) {
  let proxy;
  try { proxy = new URL(rawUrl); } catch (_) { throw new OutboundBlockedError('invalid_proxy_config'); }
  if (!['socks5:', 'socks:'].includes(proxy.protocol)) throw new OutboundBlockedError('unsupported_guarded_proxy');
  if (proxyDispatchers.size >= MAX_PROXY_REQUESTS) throw new OutboundBlockedError('proxy_request_limit');
  if (typeof Socks5ProxyAgent.prototype.createSocks5Connection !== 'function') throw new OutboundBlockedError('unsupported_socks_adapter');
  const agent = new GuardedSocksDispatcher(proxy, signal);
  proxyDispatchers.add(agent);
  return agent;
}
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function discard(body) {
  body.on('error', () => {});
  body.destroy();
}

async function raceWithSignal(operation, signal) {
  let onAbort;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

function checkWithSignal(url, signal) {
  signal.throwIfAborted();
  return raceWithSignal(assertOutboundUrl(url), signal);
}

// External, caller-controlled URLs only. Internal worker/resolver calls keep
// their existing loopback transport and never enter this public URL policy.
async function guardedRequest(rawUrl, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const deadline = performance.now() + timeoutMs;
  let url = rawUrl, method = String(options.method || 'GET').toUpperCase(), body = options.body;
  let headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([name]) =>
    !['host', 'connection', 'transfer-encoding', 'proxy-connection', 'upgrade'].includes(name.toLowerCase())));
  let proxyAgent, retained = false, released = false;
  const releaseProxy = () => {
    if (!proxyAgent || released) return;
    released = true;
    const active = proxyAgent;
    active.release().catch(() => {}).finally(() => proxyDispatchers.delete(active));
  };
  try {
    for (let hop = 0; ; hop++) {
      await checkWithSignal(url, signal);
      signal.throwIfAborted();
      let activeDispatcher;
      if (options.proxyUrl) {
        if (!proxyAgent) proxyAgent = proxyDispatcher(options.proxyUrl, signal);
        activeDispatcher = proxyAgent;
      }
      else {
        if (!dispatcher) dispatcher = createGuardedDispatcher();
        activeDispatcher = dispatcher;
      }
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
      const response = await raceWithSignal(request(url, {
        method, headers, body, signal, dispatcher: activeDispatcher,
        headersTimeout: Math.min(options.headersTimeout || remaining, remaining),
        bodyTimeout: Math.min(options.bodyTimeout || remaining, remaining),
        maxRedirections: 0
      }).then(value => {
        if (signal.aborted) discard(value.body);
        return value;
      }), signal);
      const location = response.headers.location;
      if (REDIRECTS.has(response.statusCode) && location && options.redirect === 'error') {
        discard(response.body);
        throw new TypeError('Redirect forbidden');
      }
      if (!REDIRECTS.has(response.statusCode) || !location || options.redirect === 'manual') {
        if (proxyAgent) {
          response.body.once('end', releaseProxy);
          response.body.once('close', releaseProxy);
          response.body.once('error', releaseProxy);
          retained = true;
        }
        // Undici can attach enumerable symbol metadata to the headers object.
        // Fetch Headers accepts only string names; keep actual headers without
        // passing implementation metadata into the WebIDL conversion.
        return { ...response, headers: Object.fromEntries(Object.entries(response.headers)), url };
      }
      discard(response.body);
      if (hop >= 5) throw Object.assign(new Error('Outbound redirect limit exceeded'), { code: 'ERR_OUTBOUND_REDIRECT_LIMIT' });
      let next;
      try { next = new URL(Array.isArray(location) ? location[0] : location, url); }
      catch (_) { throw new OutboundBlockedError('invalid_redirect'); }
      if (new URL(url).origin !== next.origin) {
        headers = filterRedirectHeaders(headers);
      }
      if (shouldDropRedirectBody(response.statusCode, method)) {
        method = 'GET'; body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) =>
          !['content-length', 'content-type', 'content-encoding'].includes(name.toLowerCase())));
      }
      url = next.toString();
    }
  } finally { if (!retained) releaseProxy(); }
}

async function guardedFetch(url, options) {
  try {
    const response = await guardedRequest(url, options);
    const limited = options && Number.isSafeInteger(options.maxBodyBytes) && options.maxBodyBytes > 0;
    const result = limited
      ? await require('../impitClient').readLimitedBody(response.body, options.maxBodyBytes)
      : { buffer: await response.body.arrayBuffer(), truncated: false };
    const bytes = result.buffer;
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode, url: response.url,
      headers: new Headers(response.headers), bodyTruncated: result.truncated,
      text: async () => Buffer.from(bytes).toString('utf8'),
      json: async () => JSON.parse(Buffer.from(bytes).toString('utf8')),
      arrayBuffer: async () => Buffer.isBuffer(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes
    };
  } catch (error) {
    if (options && options.signal && options.signal.aborted) throw options.signal.reason || error;
    throw error;
  }
}

async function closeGuardedDispatcher() {
  const active = dispatcher;
  const proxies = [...proxyDispatchers];
  dispatcher = undefined;
  proxyDispatchers.clear();
  await Promise.all([...(active ? [active.close()] : []), ...proxies.map(agent => agent.release()),
    require('./SharedOutboundFetch').closeSharedOutbound()]);
}

module.exports = { OutboundBlockedError, assertOutboundUrl, createGuardedLookup, createGuardedDispatcher, guardedRequest, guardedFetch, closeGuardedDispatcher };
