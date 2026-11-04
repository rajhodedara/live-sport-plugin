'use strict';
const HockeyReplaysProvider = require('../src/providers/HockeyReplaysProvider');

describe('HockeyReplays listing URLs', () => {
  const card = href => `<a href="${href}">Team A vs Team B - Full Game Replay</a>`;
  test('normalizes and deduplicates relative, absolute, and protocol-relative links', () => {
    const html = card('/game-full-game-replay') + card('https://hockeyreplays.com/game-full-game-replay') + card('//hockeyreplays.com/game-full-game-replay');
    const matches = new HockeyReplaysProvider()._parseMatchCards(html);
    expect(matches).toHaveLength(1);
    expect(matches[0].sources[0].url).toBe('https://hockeyreplays.com/game-full-game-replay');
  });
  test('preserves the host of a protocol-relative external link', () => {
    const matches = new HockeyReplaysProvider()._parseMatchCards(card('//other.example/game-full-game-replay'));
    expect(matches[0].sources[0].url).toBe('https://other.example/game-full-game-replay');
  });
});
