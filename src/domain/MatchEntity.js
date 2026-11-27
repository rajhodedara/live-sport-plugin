const { parseTimezone } = require('../timezone');

const DATE_ONLY_RE = /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2},?\s+[a-z]{3,9}\.?,?\s+\d{4})$/i;

/**
 * Converts a provider kickoff value into a millisecond epoch string.
 * Uses the robust timezone parser.
 */
function toMillis(value) {
  const parsed = parseTimezone(value, 'UTC'); // fallback if providers didn't already parse it
  return parsed ? parsed.toString() : '';
}

function inferKickoffVerified(rawValue, millisStr) {
  if (!millisStr || millisStr === '0') return false;
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) && rawValue > 0;
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed || trimmed === '0' || DATE_ONLY_RE.test(trimmed)) return false;
    if (/^\d+$/.test(trimmed)) return Number(trimmed) > 0;
    return /\d{1,2}:\d{2}/.test(trimmed);
  }
  return false;
}

class MatchEntity {
  constructor(data = {}) {
    const { id, title, category, date, timestamp, status, popular, sources, league, team1, team2, thumbnail_url, poster, logo, background, score, ...rest } = data;
    const rawDateInput = timestamp !== null && timestamp !== undefined ? timestamp : date;
    this.id = id || '';
    this.title = title || 'Unknown Match';
    this.category = category || 'other';
    this.date = toMillis(rawDateInput);
    if (rest.kickoffVerified === undefined) {
      this.kickoffVerified = inferKickoffVerified(rawDateInput, this.date);
    }
    this.status = status || '';
    // Live/final score as supplied by the provider, e.g. "2:1". Kept as a raw
    // string so a missing score stays distinguishable from a real 0:0.
    this.score = score === null || score === undefined ? '' : String(score).trim();
    this.popular = popular === '1' || popular === true ? '1' : '0';
    this.sources = Array.isArray(sources) ? sources : [];
    
    if (league && typeof league === 'object' && !Array.isArray(league)) {
      this.league = league.name || league.title || '';
    } else {
      this.league = league ? String(league) : '';
    }
    
    this.team1 = team1 || null;
    this.team2 = team2 || null;
    this.thumbnail_url = thumbnail_url || '';
    this.poster = poster || '';
    this.logo = logo || '';
    this.background = background || '';

    // Preserve custom entity fields (e.g. channel identity, canonical titles, aliasIds)
    Object.assign(this, rest);
  }
}

module.exports = MatchEntity;
