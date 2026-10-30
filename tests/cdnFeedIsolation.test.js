'use strict';
const Provider = require('../src/providers/CdnLiveProvider');
function setup(data) {
  const p = new Provider({ circuitBreaker: { wrapSync: () => ({ fire: async () => null }) } });
  p.fetchMain = { fire: async () => ({ 'cdn-live-tv': data }) }; return p;
}
test('malformed events do not hide later valid events', async () => {
  const p = setup({ Soccer: [null, { gameID: 'one', name: 'Fixture', channels: [{ url: 'https://example.invalid/a' }] }] });
  const events = await p.getEventMatches(); expect(events.map(x => x.title)).toEqual(['Fixture']);
});
test('a failed channel does not prevent later channels from resolving', async () => {
  const p = setup({ Soccer: [null, { gameID: 'event', name: 'Fixture', channels: [null, { url: 'bad' }, { url: 'good' }] }] });
  p.resolvePlayer = jest.fn(async url => { if (url === 'bad') throw new Error('fixture failure'); return [{ url: 'https://example.invalid/live.m3u8' }]; });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try { const result = await p.resolveStream('event', 'football', 'Fixture'); expect(result).toHaveLength(1); expect(p.resolvePlayer).toHaveBeenCalledTimes(2); } finally { warn.mockRestore(); }
});
