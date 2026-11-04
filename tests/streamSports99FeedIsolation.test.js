'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn(async () => ({ ok: false, status: 404 })) }));
const Provider = require('../src/providers/StreamSports99Provider');
function provider() {
  const p = new Provider({ circuitBreaker: { wrap: () => ({ fire: async () => null }) } });
  p.fetchMain = { fire: async () => ({ 'cdn-live-tv': { Soccer: [
    { gameID: 'a', name: 'First', channels: [{ url: 'https://example.invalid/a' }] }, null,
    { gameID: 'b', name: 'Second', channels: [null, { url: 'https://example.invalid/b' }] }
  ] } }) };
  return p;
}
test('malformed event does not hide later event', async () => {
  expect((await provider().getMatches()).map(m => m.title)).toEqual(['First', 'Second']);
});
test('malformed entries do not block later event resolution', async () => {
  const p = provider(); const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try { const streams = await p.resolveStream('b', 'football', 'Second'); expect(streams).toHaveLength(1); expect(streams[0].externalUrl).toBe('https://example.invalid/b'); } finally { log.mockRestore(); }
});
test('a non-string name does not abort the following events', async () => {
  const p = provider();
  p.fetchMain.fire = async () => ({ 'cdn-live-tv': { Soccer: [
    { name: 123, channels: [{}] },
    { gameID: 'valid', name: 'Valid fixture', channels: [{}] }
  ] } });
  expect((await p.getMatches()).map(m => m.title)).toEqual(['Valid fixture']);
});
