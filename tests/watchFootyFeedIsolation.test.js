'use strict';
const Provider = require('../src/providers/WatchFootyProvider');
test('invalid entries or poster URLs do not hide later valid events', async () => {
  const circuitBreaker = { wrap: () => ({ fire: async () => null }), wrapSync: () => ({ fire: async () => null }) };
  const p = new Provider({ circuitBreaker });
  p.fetchMain = { fire: async () => [
    { matchId: 'a', title: 'First', streams: [{}] }, null,
    { matchId: 'bad', title: 'Bad poster', poster: 'http://[', streams: [{}] },
    { matchId: 'b', title: 'Second', poster: '/image.png', streams: [{}] }
  ] };
  const result = await p.getMatches();
  expect(result.map(x => x.title)).toEqual(['First', 'Bad poster', 'Second']);
  expect(result[1].poster).toBeFalsy(); expect(result[2].poster).toBe('https://api.watchfooty.st/image.png');
});
