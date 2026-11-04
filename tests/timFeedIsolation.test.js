'use strict';
const Provider = require('../src/providers/TimStreamsProvider');
test('invalid feed entries do not hide later valid events', async () => {
  const p = new Provider({ circuitBreaker: { wrapSync: () => ({ fire: async () => ({ genres: [null, { id: 1, name: 'football' }], events: [
    { name: 'First', genre: 1, streams: [{ name: 'a', url: 'https://example.invalid/a' }] },
    null, { name: 'Invalid', streams: 'not-an-array' },
    { name: 'Second', genre: 1, streams: [null, { name: 'bad', url: 42 }, { name: 'b', url: 'https://example.invalid/b' }] }
  ] }) }) } });
  const result = await p.getMatches();
  expect(result.map(m => m.title)).toEqual(['First', 'Second']);
  expect(result[1].sources).toHaveLength(1);
});
