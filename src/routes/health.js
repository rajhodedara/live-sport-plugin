/**
 * routes/health.js - /health
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();
const container = require('../container');

// ─── Health Check ─────────────────────────────────────────────────────────────
// Render pings this to confirm the service is alive

router.get('/health', (_, res) => {
  let cache = null;
  try { cache = container.resolve('streamResolveCache').stats(); } catch (_) {}
  // Surface tripped circuit breakers: a provider can look "down" for minutes
  // while its upstream is healthy, and this is the only way to tell.
  let breakers = null;
  let openBreakers = [];
  try {
    const cb = container.resolve('circuitBreaker');
    if (cb && cb.getStatus) breakers = cb.getStatus();
    if (cb && cb.getOpenBreakers) openBreakers = cb.getOpenBreakers();
  } catch (_) {}
  res.json({
    status: 'ok',
    service: 'nuvio-live-sports',
    openBreakers,
    breakerCount: breakers ? Object.keys(breakers).length : null,
    streamResolveCache: cache
  });
});


module.exports = router;
