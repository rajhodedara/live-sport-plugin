'use strict';
const Provider = require('../src/providers/DamiTvProvider');
function provider(primary, secondary) {
  const p = new Provider({ circuitBreaker: { wrapSync: () => ({ fire: async () => null }) } });
  p.fetchData = { fire: jest.fn(async () => primary) };
  p.fetchAllMatches = { fire: jest.fn(async () => secondary) };
  return p;
}
test('invalid primary response does not prevent the secondary 24/7 feed', async () => {
  const p = provider({ success: false }, [{ id: '247-fixture', title: 'Fixture Channel', category: '24/7-streams' }]);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { const result = await p.getMatches(); expect(p.fetchAllMatches.fire).toHaveBeenCalledTimes(1); expect(result).toHaveLength(1); } finally { spy.mockRestore(); }
});
test('malformed categories and items do not hide later primary events', async () => {
  const p = provider({ success: true, streams: [null, { streams: null }, { category: 'football', streams: [null, { id: 'event', name: 'Fixture', status: 'live' }] }] }, []);
  const result = await p.getMatches(); expect(result).toHaveLength(1); expect(result[0].title).toBe('Fixture');
});
test('malformed source embeds and poster metadata do not drop later events', async () => {
  const p = provider({ success: true, streams: [{ category: 'football', streams: [
    { id: 'bad-title', name: 123, status: 'live' },
    { id: 'bad-source', name: 'Bad source', status: 'live', sources: [{ embed: 123 }] },
    { id: 'a', name: 'First', status: 'live', poster: { invalid: true } },
    { id: 'b', name: 'Second', status: 'live' }
  ] }] }, []);
  const result = await p.getMatches();
  expect(result.map(m => m.title)).toEqual(['First', 'Second']);
  expect(result[0].poster).toBe('');
});
