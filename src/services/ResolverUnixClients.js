'use strict';
const path = require('node:path');
const https = require('node:https');
const undici = require('undici');
const { createPinnedResolverIdentity } = require('./ResolverPinnedIdentity');

// Experimental transport adapter only. A socket pathname is not proof of
// peer ownership; this module is intentionally not wired into the app.
function createResolverUnixClients({ socketPath, legacyPort, tlsIdentity = null }, dependencies = {}) {
  const port = Number(legacyPort);
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0') ||
      path.normalize(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100 ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid resolver socket configuration');
  const Dispatcher = dependencies.Dispatcher || undici.Agent;
  const fetchFn = dependencies.fetch || undici.fetch;
  let tlsOptions = null;
  if (tlsIdentity !== null) {
    if (!tlsIdentity || typeof tlsIdentity.expectedHost !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(tlsIdentity.expectedHost)) {
      throw new TypeError('Invalid resolver TLS configuration');
    }
    const { certificatePem, expectedHost } = tlsIdentity;
    tlsOptions = { ca: certificatePem, servername: expectedHost, rejectUnauthorized: true,
      checkServerIdentity: createPinnedResolverIdentity({ certificatePem, expectedHost }) };
  }
  const dispatcher = new Dispatcher({ connect: { socketPath, ...tlsOptions } });
  let proxyAgent = false;
  if (tlsOptions) {
    try { proxyAgent = (dependencies.createProxyAgent || (options => new https.Agent(options)))(tlsOptions); }
    catch (error) { try { const cleanup = dispatcher.destroy?.(); cleanup?.catch?.(() => {}); } catch (_) {} throw error; }
  }
  let closed = false, closing;
  return {
    available() { return !closed; },
    async request(rawUrl, opts = {}) {
      if (closed) throw new Error('Resolver transport unavailable');
      let url;
      try { url = new URL(rawUrl); } catch (_) { throw new TypeError('Invalid resolver request'); }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port || 80) !== port ||
          url.username || url.password || url.hash || !url.pathname.startsWith('/api/cache/')) {
        throw new TypeError('Invalid resolver request');
      }
      // Undici connects via socketPath, not the URL hostname. The original
      // URL is restricted above so the adapter cannot become a general proxy.
      if (tlsOptions) url.protocol = 'https:';
      return fetchFn(url.href, { ...opts, dispatcher, redirect: 'error' });
    },
    proxyOptions: Object.freeze({ target: Object.freeze({ protocol: tlsOptions ? 'https:' : 'http:', socketPath, pathname: '/api' }),
      agent: proxyAgent, ...(tlsOptions ? { secure: true } : {}), followRedirects: false }),
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          let failure;
          try { if (proxyAgent) proxyAgent.destroy(); } catch (error) { failure = error; }
          try { await dispatcher.close(); } catch (error) { if (!failure) failure = error; }
          if (failure) throw failure;
        })();
      }
      return closing;
    }
  };
}

function createPinnedResolverUnixClients(config, dependencies) {
  if (!config?.tlsIdentity) throw new TypeError('Resolver TLS identity required');
  return createResolverUnixClients(config, dependencies);
}

module.exports = { createResolverUnixClients, createPinnedResolverUnixClients };
