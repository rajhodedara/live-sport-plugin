const CircuitBreaker = require('opossum');

// Per-call budget for every wrapped provider operation. Exported so callers
// that set their own inner timeout (DaddyLive's schedule fetch) can stay
// safely BELOW it, instead of silently exceeding it and being cut short.
const BREAKER_TIMEOUT_MS = 20000;

// Options for operations invoked at SYNC cadence — once per revalidate cycle
// (CATALOG_REVALIDATE_MS, default 10 min) or the 4-hour cron. Opossum's
// default 10-second rolling stats window can never accumulate volumeThreshold
// calls at that cadence, so a sync-path breaker configured with the defaults
// can NEVER open, no matter how consistently the upstream fails (verified
// empirically: 6 consecutive failures 10.5s apart, breaker stayed closed).
// A 45-minute window in 45 one-minute buckets sees 3 failures (with at most
// one success among them) reach the 67% error threshold and trip the breaker;
// resetTimeout then probe-recovers it as usual. Carry-forward in
// MatchAggregator keeps the catalog stable while a tripped sync breaker is
// open, so fast-failing here is safe.
const SYNC_CADENCE_OPTIONS = {
  rollingCountTimeout: 45 * 60 * 1000,
  rollingCountBuckets: 45,
  volumeThreshold: 3,
  errorThresholdPercentage: 67,
};

class CircuitBreakerService {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Wraps an async function in a circuit breaker.
   * With the default options the breaker trips when >= 50% of at least 5 calls
   * inside a 10-second window fail, and probes recovery after 90s.
   */
  wrap(name, asyncFunction, customOptions = {}) {
    if (this.breakers.has(name)) {
      return this.breakers.get(name);
    }

    const options = {
      timeout: BREAKER_TIMEOUT_MS, // If function takes longer than this, trigger a failure
      errorThresholdPercentage: 50, // When 50% of requests fail, trip the circuit
      resetTimeout: 90 * 1000, // After 90s, try again
      volumeThreshold: 5, // Wait for at least 5 failures before tripping
      ...customOptions
    };

    const breaker = new CircuitBreaker(asyncFunction, options);

    breaker.fallback((err) => {
      const reason = err ? err.message : 'Unknown';
      console.warn(`[CircuitBreaker] ${name} Fallback triggered. Reason: ${reason}`);
      return null;
    });

    breaker.on('open', () => console.warn(`[CircuitBreaker] ${name} TRIPPED OPEN.`));
    breaker.on('halfOpen', () => console.info(`[CircuitBreaker] ${name} HALF-OPEN. Testing recovery.`));
    breaker.on('close', () => console.info(`[CircuitBreaker] ${name} CLOSED. Fully recovered.`));

    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * wrap() variant for SYNC-path operations (provider list/schedule fetches
   * called once per revalidate cycle). Uses a rolling window long enough to
   * see that cadence, so the breaker can actually open when an upstream dies.
   * See SYNC_CADENCE_OPTIONS for the reasoning.
   */
  wrapSync(name, asyncFunction, customOptions = {}) {
    return this.wrap(name, asyncFunction, { ...SYNC_CADENCE_OPTIONS, ...customOptions });
  }

  /**
   * Snapshot of every breaker's state, for /health and diagnostics.
   * A tripped breaker is the single most confusing failure mode in this addon:
   * the provider looks "down" for minutes while the upstream is actually fine.
   * Exposing it lets an operator tell that apart from a real outage instantly.
   */
  getStatus() {
    const out = {};
    for (const [name, breaker] of this.breakers) {
      let state = 'closed';
      if (breaker.opened) state = 'open';
      else if (breaker.halfOpen) state = 'halfOpen';
      out[name] = {
        state,
        failures: breaker.stats ? breaker.stats.failures : undefined,
        successes: breaker.stats ? breaker.stats.successes : undefined,
        fallbacks: breaker.stats ? breaker.stats.fallbacks : undefined
      };
    }
    return out;
  }

  /** Names of currently tripped breakers (empty when everything is healthy). */
  getOpenBreakers() {
    const open = [];
    for (const [name, breaker] of this.breakers) {
      if (breaker.opened) open.push(name);
    }
    return open;
  }
}

module.exports = CircuitBreakerService;
module.exports.BREAKER_TIMEOUT_MS = BREAKER_TIMEOUT_MS;
module.exports.SYNC_CADENCE_OPTIONS = SYNC_CADENCE_OPTIONS;
