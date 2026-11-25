'use strict';

function providerIdentity(provider) {
  const raw = provider && (provider.sourceName || provider.name || (provider.constructor && provider.constructor.name));
  const name = String(raw || 'unknown').trim() || 'unknown';
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown',
    name,
  };
}

function safeErrorMessage(error) {
  const message = error && error.message ? error.message : String(error || 'Unknown provider error');
  // Diagnostics should be useful without retaining signed query strings or
  // excessively large upstream responses.
  return message
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, '$1?[redacted]')
    .slice(0, 240);
}

class ProviderHealthService {
  constructor() {
    this.providers = new Map();
    this.sync = {
      state: 'idle',
      lastStartedAt: null,
      lastCompletedAt: null,
      durationMs: null,
      matchCount: null,
    };
    this._syncStartedMs = null;
  }

  registerProviders(providers) {
    for (const provider of providers || []) {
      const identity = providerIdentity(provider);
      if (!this.providers.has(identity.id)) {
        this.providers.set(identity.id, {
          ...identity,
          state: 'unknown',
          matchCount: null,
          durationMs: null,
          lastAttemptAt: null,
          lastSuccessAt: null,
          error: null,
          consecutiveFailures: 0,
          scheduleOk: null,
          carriedForwardCount: 0,
          note: 'Waiting for the first catalog sync',
        });
      }
    }
  }

  startSync() {
    const now = Date.now();
    this._syncStartedMs = now;
    this.sync = {
      ...this.sync,
      state: 'running',
      lastStartedAt: new Date(now).toISOString(),
      durationMs: null,
      matchCount: null,
    };
    for (const record of this.providers.values()) {
      record.carriedForwardCount = 0;
    }
  }

  recordResult(provider, { matches, durationMs, error } = {}) {
    this.registerProviders([provider]);
    const identity = providerIdentity(provider);
    const record = this.providers.get(identity.id);
    const count = Array.isArray(matches) ? matches.length : 0;
    const scheduleOk = typeof provider?.lastScheduleOk === 'boolean' ? provider.lastScheduleOk : null;
    const hasError = !!error;
    const isDegraded = !hasError && scheduleOk === false;
    const state = hasError ? 'error' : (isDegraded ? 'degraded' : (count > 0 ? 'healthy' : 'empty'));
    const succeeded = state === 'healthy';

    Object.assign(record, {
      state,
      matchCount: count,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: succeeded ? new Date().toISOString() : record.lastSuccessAt,
      error: hasError ? safeErrorMessage(error) : null,
      consecutiveFailures: succeeded ? 0 : record.consecutiveFailures + 1,
      scheduleOk,
      note: isDegraded
        ? 'Provider responded, but its schedule fetch failed'
        : (state === 'empty' ? 'Provider returned no fixtures' : null),
    });
  }

  recordCached(provider, matchCount, note) {
    this.registerProviders([provider]);
    const identity = providerIdentity(provider);
    const record = this.providers.get(identity.id);
    Object.assign(record, {
      state: 'cached',
      matchCount: Number.isFinite(matchCount) ? matchCount : 0,
      durationMs: 0,
      error: null,
      note: note || 'Fresh cached fixtures reused',
    });
  }

  recordCarryForward(providerName, count) {
    const wanted = String(providerName || '').toLowerCase();
    for (const record of this.providers.values()) {
      if (record.id === wanted || record.name.toLowerCase() === wanted) {
        record.carriedForwardCount = Number.isFinite(count) ? count : 0;
        if (count > 0 && record.state !== 'healthy') {
          record.note = `${count} previous fixture${count === 1 ? '' : 's'} carried forward`;
        }
        return;
      }
    }
  }

  recordAuxiliaryResult(provider, { itemCount, durationMs, error, note } = {}) {
    this.registerProviders([provider]);
    const identity = providerIdentity(provider);
    const record = this.providers.get(identity.id);
    const hasError = !!error;
    const count = Number.isFinite(itemCount) ? Math.max(0, Math.round(itemCount)) : 0;
    const now = new Date().toISOString();
    Object.assign(record, {
      state: hasError ? 'error' : (count > 0 ? 'healthy' : 'empty'),
      matchCount: count,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
      lastAttemptAt: now,
      lastSuccessAt: hasError ? record.lastSuccessAt : now,
      error: hasError ? safeErrorMessage(error) : null,
      consecutiveFailures: hasError ? record.consecutiveFailures + 1 : 0,
      note: note || null,
    });
  }

  recordEnrichment(provider, { enrichedFixtures, totalSourcesAttached } = {}) {
    this.registerProviders([provider]);
    const identity = providerIdentity(provider);
    const record = this.providers.get(identity.id);
    Object.assign(record, {
      enrichedFixtures: Number.isFinite(enrichedFixtures) ? Math.max(0, Math.round(enrichedFixtures)) : 0,
      attachedSources: Number.isFinite(totalSourcesAttached) ? Math.max(0, Math.round(totalSourcesAttached)) : 0,
      lastEnrichmentAt: new Date().toISOString(),
    });
  }

  finishSync({ matchCount, succeeded } = {}) {
    const now = Date.now();
    this.sync = {
      ...this.sync,
      state: succeeded ? 'complete' : 'failed',
      lastCompletedAt: new Date(now).toISOString(),
      durationMs: this._syncStartedMs === null ? null : Math.max(0, now - this._syncStartedMs),
      matchCount: Number.isFinite(matchCount) ? matchCount : null,
    };
    this._syncStartedMs = null;
  }

  recordKafkaPlayback({
    discovered,
    localHits = 0,
    sqliteHits,
    upstreamSearches = 0,
    sharedSearches = 0,
    attempts = 0,
    verified = 0,
    reason = 'unknown',
    searchStats = null
  } = {}) {
    this.registerProviders([{ name: 'Kafka' }]);
    const record = this.providers.get('kafka');
    const toCount = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
    const stopReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'unknown';
    const previous = record.eventPlayback || {
      mints: 0,
      discovered: 0,
      localHits: 0,
      sqliteHits: 0,
      upstreamSearches: 0,
      sharedSearches: 0,
      attempts: 0,
      verified: 0,
      stops: {}
    };
    const next = {
      mints: previous.mints + 1,
      discovered: (previous.discovered || 0) + toCount(discovered ?? localHits),
      localHits: previous.localHits + toCount(localHits),
      sqliteHits: previous.sqliteHits + toCount(sqliteHits ?? localHits),
      upstreamSearches: previous.upstreamSearches + toCount(upstreamSearches),
      sharedSearches: previous.sharedSearches + toCount(sharedSearches),
      attempts: previous.attempts + toCount(attempts),
      verified: previous.verified + toCount(verified),
      stops: { ...previous.stops, [stopReason]: (previous.stops[stopReason] || 0) + 1 }
    };
    if (searchStats && typeof searchStats === 'object') {
      next.searchTotals = {
        requests: toCount(searchStats.requests),
        sweepRequests: toCount(searchStats.sweepRequests),
        shared: toCount(searchStats.shared)
      };
    } else if (previous.searchTotals) {
      next.searchTotals = { ...previous.searchTotals };
    }
    record.eventPlayback = next;
  }

  recordKafkaSearchStats(searchStats = {}) {
    if (!searchStats || typeof searchStats !== 'object') return;
    this.registerProviders([{ name: 'Kafka' }]);
    const record = this.providers.get('kafka');
    const toCount = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
    const previous = record.eventPlayback || {
      mints: 0,
      discovered: 0,
      localHits: 0,
      sqliteHits: 0,
      upstreamSearches: 0,
      sharedSearches: 0,
      attempts: 0,
      verified: 0,
      stops: {}
    };
    record.eventPlayback = {
      ...previous,
      stops: { ...previous.stops },
      searchTotals: {
        requests: toCount(searchStats.requests),
        sweepRequests: toCount(searchStats.sweepRequests),
        shared: toCount(searchStats.shared)
      }
    };
  }

  snapshot() {
    return {
      sync: { ...this.sync },
      providers: [...this.providers.values()]
        .map((record) => ({
          ...record,
          ...(record.eventPlayback ? {
            eventPlayback: {
              ...record.eventPlayback,
              stops: { ...record.eventPlayback.stops },
              ...(record.eventPlayback.searchTotals ? { searchTotals: { ...record.eventPlayback.searchTotals } } : {})
            }
          } : {})
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}

module.exports = ProviderHealthService;
module.exports.providerIdentity = providerIdentity;
module.exports.safeErrorMessage = safeErrorMessage;
