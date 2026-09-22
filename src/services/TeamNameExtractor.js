/**
 * TeamNameExtractor.js
 *
 * Derives the two competitors from a fixture title.
 *
 * Several providers publish a head-to-head title but never populate
 * team1/team2 -- tennis singles ("WTA - Singles: A vs B") is the common case,
 * and some domestic cup fixtures do the same. Without competitor names the
 * match card has no fixture shape at all and degrades to a bare text tile, and
 * crest enrichment skips the fixture entirely.
 *
 * Only unambiguous fixture separators are split on ("vs", "vs.", "v", "@").
 * Dash separators are deliberately NOT used: motorsport and show titles such as
 * "Nascar Cup Series 2026 - Hollywood Casino 400" are "X - Y" shaped but are not
 * two competitors, and splitting them would fabricate matchups that do not exist.
 *
 * Shared by the catalog mapper (render time) and the aggregator (so the names
 * are persisted and covered by crest enrichment).
 */
'use strict';

const VS_SPLIT = /\s+(?:vs\.?|v|@)\s+/i;

function extractTeamsFromTitle(title) {
  if (!title || typeof title !== 'string') return null;
  if (!VS_SPLIT.test(title)) return null;

  // Category prefixes such as "WTA - Singles:" name the competition, not a
  // competitor, so drop everything up to the final colon before splitting.
  let t = title.trim();
  const colon = t.lastIndexOf(':');
  if (colon > 0 && colon < t.length - 3) t = t.slice(colon + 1).trim();

  const parts = t.split(VS_SPLIT);
  if (parts.length !== 2) return null;
  const a = parts[0].trim();
  const b = parts[1].trim();
  const plausible = (s) => s.length >= 2 && s.length <= 48 && /[A-Za-z0-9]/.test(s);
  if (!plausible(a) || !plausible(b)) return null;
  return [a, b];
}

module.exports = { extractTeamsFromTitle };
