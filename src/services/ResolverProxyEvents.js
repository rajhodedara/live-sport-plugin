'use strict';
const conflictState = require('./ResolverConflictState');

function createResolverProxyEvents(state = conflictState) {
  function unavailable(res) {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) return res.status(503).send('Internal stream resolver unavailable.');
    res.destroy();
  }
  function proxyReq(upstream, _req, res) {
    const destroyUpstream = () => { try { upstream.destroy(); } catch (_) { /* best effort */ } };
    if (res.destroyed || res.writableEnded) { destroyUpstream(); return; }
    let signal;
    try {
      signal = state.signal();
      if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') throw new TypeError('Invalid conflict signal');
    } catch (_) { destroyUpstream(); try { unavailable(res); } catch (_) {} return; }
    let canceled = false;
    const cleanup = () => { try { signal.removeEventListener('abort', cancel); } catch (_) {} };
    const cancel = () => {
      if (canceled) return;
      canceled = true;
      destroyUpstream();
      try { unavailable(res); } catch (_) {} finally { cleanup(); }
    };
    try {
      signal.addEventListener('abort', cancel, { once: true });
      res.once('close', cleanup);
      if (signal.aborted) cancel();
    } catch (_) { cancel(); }
  }
  function error(_failure, _req, res) {
    if (!res || res.writableEnded || res.destroyed) return;
    if (!res.headersSent) return res.status(502).send('Bad Gateway: Internal stream resolver is not responding.');
    res.destroy();
  }
  return { proxyReq, error };
}

module.exports = createResolverProxyEvents();
module.exports.createResolverProxyEvents = createResolverProxyEvents;
