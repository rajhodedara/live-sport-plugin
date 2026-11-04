'use strict';
const https = require('node:https');
const undici = require('undici');
const { createPinnedResolverIdentity } = require('./ResolverPinnedIdentity');

// Experimental building block: not wired to the app. Real TLS handshakes,
// credential distribution, reloads and both worker paths still need testing.
function createPinnedResolverClients({ certificatePem, expectedHost, port }, dependencies = {}) {
  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65535 ||
      typeof expectedHost !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(expectedHost)) {
    throw new TypeError('Invalid resolver TLS configuration');
  }
  const verify = createPinnedResolverIdentity({ certificatePem, expectedHost });
  const tlsOptions = { ca: certificatePem, servername: expectedHost, rejectUnauthorized: true, checkServerIdentity: verify };
  const Dispatcher = dependencies.Dispatcher || undici.Agent;
  const proxyAgentFactory = dependencies.createProxyAgent || (options => new https.Agent(options));
  const fetchFn = dependencies.fetch || undici.fetch;
  // Use `connect`, not `tls`; this matters for versions with the published
  // Undici Agent option-cloning issue. End-to-end handshake testing is required.
  const dispatcher = new Dispatcher({ connect: { ...tlsOptions } });
  let proxyAgent;
  try { proxyAgent = proxyAgentFactory({ ...tlsOptions, keepAlive: true }); }
  catch (error) {
    try { const cleanup = dispatcher.destroy?.(); cleanup?.catch?.(() => {}); } catch (_) {}
    throw error;
  }
  let closing = null, closed = false;
  return {
    // This is only local adapter availability, not resolver readiness or proof
    // of ownership. Authentication happens on each TLS connection.
    available() { return !closed; },
    async request(rawUrl, opts = {}) {
      if (closed) throw new Error('Resolver transport unavailable');
      let url;
      try { url = new URL(rawUrl); } catch (_) { throw new TypeError('Invalid resolver request'); }
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port || 80) !== numericPort ||
          url.username || url.password || url.hash || !url.pathname.startsWith('/api/cache/')) {
        throw new TypeError('Invalid resolver request');
      }
      url.protocol = 'https:';
      url.port = String(numericPort);
      return fetchFn(url.href, { ...opts, dispatcher, redirect: 'error' });
    },
    proxyOptions: Object.freeze({ target: `https://127.0.0.1:${numericPort}/api`, agent: proxyAgent, secure: true,
      followRedirects: false }),
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        let proxyFailure;
        try { proxyAgent.destroy(); } catch (failure) { proxyFailure = failure; }
        try { await dispatcher.close(); } catch (failure) { if (!proxyFailure) proxyFailure = failure; }
        if (proxyFailure) throw proxyFailure;
      })();
      return closing;
    }
  };
}

module.exports = { createPinnedResolverClients };
