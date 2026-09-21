const { parseTimezone } = require('../timezone');

/**
 * Converts a provider kickoff value into a millisecond epoch string.
 * Uses the robust timezone parser.
 */
function toMillis(value) {
  const parsed = parseTimezone(value, 'UTC'); // fallback if providers didn't already parse it
  return parsed ? parsed.toString() : '';
}

class MatchEntity {
  constructor({ id, title, category, date, timestamp, status, popular, sources, league, team1, team2, thumbnail_url, poster, logo, background, score }) {
    this.id = id || '';
    this.title = title || 'Unknown Match';
    this.category = category || 'other';
    this.date = toMillis(timestamp !== null && timestamp !== undefined ? timestamp : date);
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
  }
}

module.exports = MatchEntity;
