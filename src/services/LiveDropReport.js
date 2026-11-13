'use strict';

// Observability only. Finds fixtures that were LIVE in the previous cache and are
// absent from the fresh sync, and says which providers carried them and whether
// those providers still answered. It never changes what is cached or shown.

const HOUR_MS = 3600000;
const DEFAULT_LIVE_WINDOW_MS = 14 * HOUR_MS;
const DEFAULT_MAX_ROWS = 20;

function identityKeys(row) {
  const out = new Set();
  if (!row) return out;
  if (row.id !== null && row.id !== undefined && String(row.id).trim() !== '') out.add(String(row.id));
  if (Array.isArray(row.aliasIds)) {
    for (const a of row.aliasIds) if (a !== null && a !== undefined && String(a).trim() !== '') out.add(String(a));
  }
  return out;
}

function providersOf(row) {
  const set = new Set();
  if (Array.isArray(row && row.sources)) {
    for (const s of row.sources) if (s && s.source) set.add(String(s.source));
  }
  return [...set].sort();
}

/**
 * @param {object[]} previousRows rows of the previous cache
 * @param {object[]} freshRows rows of this sync (after carry-forward)
 * @param {{now:number, parseDate:(raw:any)=>number, liveWindowMs?:number, maxRows?:number}} opts
 * @returns {{total:number, rows:object[]}} rows sorted by minutes since kickoff (oldest first), capped
 */
function findDroppedLiveFixtures(previousRows, freshRows, opts) {
  const { now, parseDate } = opts;
  const liveWindowMs = opts.liveWindowMs || DEFAULT_LIVE_WINDOW_MS;
  const maxRows = opts.maxRows || DEFAULT_MAX_ROWS;
  const fresh = new Set();
  const freshProviders = new Set();
  for (const row of freshRows || []) {
    for (const k of identityKeys(row)) fresh.add(k);
    for (const p of providersOf(row)) freshProviders.add(p);
  }
  const dropped = [];
  for (const prev of previousRows || []) {
    if (!prev || prev.isReplay) continue;
    const providers = providersOf(prev);
    if (providers.length === 0) continue;
    const kickoff = parseDate(prev.date);
    if (!kickoff || kickoff > now) continue;
    const elapsed = now - kickoff;
    if (elapsed > liveWindowMs) continue;
    const keys = identityKeys(prev);
    let present = false;
    for (const k of keys) { if (fresh.has(k)) { present = true; break; } }
    if (present) continue;
    dropped.push({
      id: String(prev.id || ''),
      category: String(prev.category || 'unknown'),
      minutesSinceKickoff: Math.round(elapsed / 60000),
      providers,
      providersAnswered: providers.filter((p) => freshProviders.has(p)),
    });
  }
  dropped.sort((a, b) => b.minutesSinceKickoff - a.minutesSinceKickoff);
  return { total: dropped.length, rows: dropped.slice(0, maxRows) };
}

function formatDropLine(row) {
  const safeId = row.id.replace(/[^\w.:-]/g, '_').slice(0, 80);
  return `[LiveDrop] id=${safeId} category=${row.category} min_since_kickoff=${row.minutesSinceKickoff} `
    + `providers=${row.providers.join(',')} answered=${row.providersAnswered.join(',') || 'none'}`;
}

module.exports = { findDroppedLiveFixtures, formatDropLine, DEFAULT_LIVE_WINDOW_MS };
