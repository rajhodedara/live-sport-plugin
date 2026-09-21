/**
 * timezone.js
 *
 * Parses a date string and a timezone into a stable UTC UNIX timestamp (milliseconds).
 *
 * The incoming value is treated as a WALL-CLOCK time in `timeZone` (never in the
 * server's own zone), so the result does not depend on the host's TZ setting.
 *
 * @param {string|number} dateValue - The date string or UNIX timestamp.
 * @param {string} [timeZone='UTC'] - IANA Timezone string (e.g., 'America/New_York', 'UTC').
 * @returns {number|null} - UTC UNIX timestamp in milliseconds, or null if invalid.
 *
 *
 * PERFORMANCE NOTE
 * ----------------
 * `getKickoff()` in catalog.js calls this for every match, inside filter and
 * sort callbacks, several times per catalog request. Measured on the production
 * match set (3382 matches, 2449 with a date, only 251 distinct date values):
 * constructing `Intl.DateTimeFormat` costs ~0.37 ms, so one uncached pass spent
 * ~900 ms doing pure Intl work and each request made 3-4 such passes.
 *
 * Two caches below remove essentially all of it, and both are lossless:
 * identical input still yields an identical result, so no caller changes
 * behaviour.
 *
 *   1. `_formatterCache` / `_dateFormatterCache` - the formatter objects are
 *      built once per timezone and reused. Constructing them is the expensive
 *      part and it is idempotent for a given option set.
 *   2. `_parseCache` - memoizes the resolved instant per (date string, zone).
 *      The match set repeats the same kickoff strings ~9.8x, so this collapses
 *      2449 parses into 251. Relative "HH:MM" inputs are deliberately NOT
 *      cached because they depend on the current date.
 */

'use strict';

// Formatter construction is the dominant cost of a parse, and it is idempotent
// per (timezone, option set), so each variant is built once and reused. Two
// variants exist: the full date+time formatter used for offset maths, and a
// date-only formatter used to resolve "HH:MM" against today's date in the target
// zone. They must stay separate ΓÇö the date-only path splits the result on '/',
// which only holds for the year/month/day formatter.
const _formatterCache = new Map();
const _dateFormatterCache = new Map();
const _FORMATTER_CACHE_MAX = 32;

function _buildFormatter(timeZone, options) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options });
  } catch (_) {
    // Unknown timezone: fall back to UTC rather than throwing on every call.
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options });
  }
}

function _memoizeFormatter(cache, timeZone, options) {
  let fmt = cache.get(timeZone);
  if (fmt) return fmt;
  fmt = _buildFormatter(timeZone, options);
  if (cache.size >= _FORMATTER_CACHE_MAX) {
    // Drop the oldest entry; the map is tiny and churn is negligible.
    cache.delete(cache.keys().next().value);
  }
  cache.set(timeZone, fmt);
  return fmt;
}

/** Full date+time formatter (used by the offset maths). */
function _getFormatter(timeZone) {
  return _memoizeFormatter(_formatterCache, timeZone, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
}

/** Date-only formatter (used to date a bare "HH:MM" in the target zone). */
function _getDateFormatter(timeZone) {
  return _memoizeFormatter(_dateFormatterCache, timeZone, {
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
}

/**
 * Offset of `timeZone` at the given UTC instant, in milliseconds
 * (wall clock minus UTC, so America/New_York in summer is -4h).
 *
 * Intl is used purely as a formatter here; the caller is responsible for
 * solving the intended wall time against it.
 */
function _zoneOffsetMs(utcMs, timeZone) {
  const parts = _getFormatter(timeZone).formatToParts(new Date(utcMs));

  const p = {};
  parts.forEach(part => { p[part.type] = part.value; });

  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0; // Intl.DateTimeFormat can return 24 for midnight

  const asUtc = Date.UTC(
    parseInt(p.year, 10),
    parseInt(p.month, 10) - 1,
    parseInt(p.day, 10),
    hour,
    parseInt(p.minute, 10),
    parseInt(p.second, 10)
  );

  return asUtc - utcMs;
}

/**
 * Resolve a wall-clock time in `timeZone` to its UTC instant.
 *
 * The old implementation derived the offset by formatting the naive instant
 * itself (`walltime + 'Z'`). Inside the hour after a DST transition that offset
 * belongs to the wrong side of the change, so every conversion in that window
 * came out one hour wrong (observed: 2026-03-08T03:30 America/New_York resolved
 * to 08:30Z instead of 07:30Z).
 *
 * Instead we solve for the instant whose rendering in `timeZone` equals the
 * requested wall clock. We consider the offsets in force a day either side of
 * the target so both sides of a transition are tested, keep only solutions that
 * round-trip, and for the ambiguous repeated hour of a fall-back we return the
 * EARLIER instant. A wall time that does not exist (the skipped hour of a
 * spring-forward) has no round-tripping solution and falls back to interpreting
 * it with the pre-transition offset, which shifts it forward by the gap.
 */
function _wallTimeToUtc(wallMs, timeZone) {
  const candidates = [];
  const seenOffsets = new Set();

  for (const probe of [wallMs - 86400000, wallMs, wallMs + 86400000]) {
    const offset = _zoneOffsetMs(probe, timeZone);
    if (seenOffsets.has(offset)) continue;
    seenOffsets.add(offset);

    const instant = wallMs - offset;
    if (_zoneOffsetMs(instant, timeZone) === offset) candidates.push(instant);
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => a - b);
    return candidates[0]; // earliest wins for the ambiguous fall-back hour
  }

  // Nonexistent wall time: keep the pre-transition offset (shifts forward).
  return wallMs - _zoneOffsetMs(wallMs, timeZone);
}

// Memo for resolved parses: "<zone>\u0000<raw value>" -> result (number | null).
// A Map keeps an undefined-vs-null distinction impossible to confuse, so a
// cached null result is returned as null rather than re-parsed.
const _parseCache = new Map();
const _PARSE_CACHE_MAX = 20000;

function _cacheGet(key) {
  if (!_parseCache.has(key)) return undefined;
  const value = _parseCache.get(key);
  // Refresh recency so frequently used entries survive eviction.
  _parseCache.delete(key);
  _parseCache.set(key, value);
  return value;
}

function _cacheSet(key, value) {
  if (_parseCache.size >= _PARSE_CACHE_MAX) {
    // Map preserves insertion order: drop the oldest entry.
    _parseCache.delete(_parseCache.keys().next().value);
  }
  _parseCache.set(key, value);
  return value;
}

function parseTimezone(dateValue, timeZone = 'UTC') {
  if (dateValue === null || dateValue === undefined) return null;

  // If it's already a valid number (UNIX timestamp), return it (assuming milliseconds if > 1e11)
  if (typeof dateValue === 'number') {
    if (!Number.isFinite(dateValue) || dateValue <= 0) return null;
    return dateValue < 1e11 ? dateValue * 1000 : dateValue;
  }

  const str = String(dateValue).trim();
  if (!str || str === '0') return null;

  // Relative wall-clock inputs ("21:30") depend on the current date, so they are
  // deliberately not cached.
  const isTimeOnly = /^\d{1,2}:\d{2}(:\d{2})?$/.test(str.replace(' ', 'T'));
  const cacheKey = isTimeOnly ? null : `${timeZone}\u0000${str}`;

  if (cacheKey) {
    const hit = _cacheGet(cacheKey);
    if (hit !== undefined) return hit;
  }

  const computed = _parseTimezoneUncached(str, timeZone);
  if (cacheKey) _cacheSet(cacheKey, computed);
  return computed;
}

function _parseTimezoneUncached(str, timeZone) {
  // If it's a numeric string representing a timestamp
  const numeric = Number(str);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    return numeric < 1e11 ? numeric * 1000 : numeric;
  }

  // If the string contains an explicit timezone offset like Z or +05:30
  // we can just let native Date parse it, as it overrides local timezone assumptions
  const hasTimezoneOffset = str.endsWith('Z') || str.match(/[+-]\d{2}:?\d{2}$/);
  if (hasTimezoneOffset) {
    const t = new Date(str).getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }

  // Replace spaces with T for proper ISO format compatibility
  let cleanStr = str.replace(' ', 'T');

  // If the string is just a time (e.g. "21:30" or "21:30:00"), prepend today's date in target timezone.
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(cleanStr)) {
    const tzDateStr = _getDateFormatter(timeZone).format(new Date());
    const [mm, dd, yyyy] = tzDateStr.split('/');
    // Use padStart to ensure time has leading zeros for valid ISO format
    let timePart = cleanStr;
    if (timePart.length === 4) timePart = '0' + timePart; // e.g. "9:30" -> "09:30"
    cleanStr = `${yyyy}-${mm}-${dd}T${timePart}`;
  }

  // We treat the incoming local time string as if it were UTC.
  // Example: "2026-08-16T16:05" -> "2026-08-16T16:05Z"
  // The UTC fields of this instant are exactly the requested wall-clock fields.
  const localDate = new Date(cleanStr + 'Z');
  if (isNaN(localDate.getTime())) return null;

  // Apply the offset to get the true UTC UNIX timestamp
  const trueUtcTime = _wallTimeToUtc(localDate.getTime(), timeZone);
  return trueUtcTime > 0 ? trueUtcTime : null;
}

module.exports = { parseTimezone };
