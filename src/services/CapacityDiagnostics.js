'use strict';

// Observability for native-pool capacity rejections. Nothing here reserves
// capacity, changes admission or alters an error's code/message: it only labels
// and counts rejections so the (throttled) capacity log can say WHO is asking and
// WHICH upstream the pressure is aimed at.

const MAX_KEYS = 40;      // bound memory under hostile/high-cardinality hostnames
const TOP_HOSTS = 5;      // hostnames reported per log line

// Record only the hostname (no path, query or credentials) of a request the pool
// refused. Mutates the failure's diagnostic in place; a no-op without one.
function attachDiagnosticHost(failure, hostname) {
  const requested = failure && failure.capacityDiagnostic && failure.capacityDiagnostic.requested;
  if (requested && typeof hostname === 'string' && hostname && requested.host === undefined) {
    requested.host = hostname.slice(0, 120);
  }
}

function createCapacityWindow() {
  let total = 0;
  let owners = new Map();
  let hosts = new Map();

  const bump = (map, rawKey) => {
    let key = typeof rawKey === 'string' && rawKey ? rawKey.slice(0, 120) : 'unknown';
    if (!map.has(key) && map.size >= MAX_KEYS) key = '_other';
    map.set(key, (map.get(key) || 0) + 1);
  };
  const top = (map, limit) => Object.fromEntries(
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));

  return {
    record(failure) {
      const requested = failure && failure.capacityDiagnostic && failure.capacityDiagnostic.requested;
      total++;
      bump(owners, requested && requested.owner);
      bump(hosts, requested && requested.host);
    },
    // Counts since the previous snapshot; resets the window.
    snapshot() {
      const out = { total, byOwner: top(owners, MAX_KEYS), byHost: top(hosts, TOP_HOSTS) };
      total = 0; owners = new Map(); hosts = new Map();
      return out;
    },
    reset() { total = 0; owners = new Map(); hosts = new Map(); },
  };
}

module.exports = { attachDiagnosticHost, createCapacityWindow, MAX_KEYS, TOP_HOSTS };
