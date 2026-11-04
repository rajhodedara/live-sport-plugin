'use strict';
const Provider = require('../src/providers/PpvStProvider');
function setup(streams) {
  const provider = new Provider();
  provider.proxyFetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, streams: [{ category: 'football', streams }] }) }));
  return provider;
}
test('keeps an event with only playable alternate sources', async () => {
  const provider = setup([{ id: 'event', name: 'Team A vs Team B', starts_at: 2000000000, substreams: [{ id: 'sub', iframe: 'https://example.invalid/embed/sub', locale: 'en' }] }]);
  const matches = await provider.getMatches();
  expect(matches).toHaveLength(1);
  expect(matches[0].sources).toEqual([expect.objectContaining({ id: 'sub', embedUrl: 'https://example.invalid/embed/sub', language: 'en' })]);
});
test('keeps a parent plus alternate and omits entries without links', async () => {
  const provider = setup([{ id: 'one', name: 'Fixture', iframe: 'https://example.invalid/embed/main', substreams: [{ id: 'sub', iframe: 'https://example.invalid/embed/sub' }] }, { id: 'empty', name: 'Empty', substreams: [{ id: 'none' }] }]);
  const matches = await provider.getMatches();
  expect(matches).toHaveLength(1); expect(matches[0].sources.map(s => s.id)).toEqual(['one', 'sub']);
});

test('skips malformed categories and events while keeping later valid entries', async () => {
  const provider = new Provider();
  provider.proxyFetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, streams: [
    { category: 'football', streams: [{ id: 'one', name: 'First', iframe: 'https://example.invalid/embed/one' }, null, { id: 'bad', iframe: 'https://example.invalid/embed/bad' }] },
    null, { category: null, streams: [] }, { category: 'football', streams: null },
    { category: 'basketball', streams: [{ id: 'two', name: 'Second', iframe: 'https://example.invalid/embed/two', substreams: [null, { id: 'sub', iframe: 'https://example.invalid/embed/sub' }] }] }
  ] }) }));
  const matches = await provider.getMatches();
  expect(matches.map(m => m.title)).toEqual(['First', 'Second']);
  expect(matches[1].sources.map(s => s.id)).toEqual(['two', 'sub']);
});
test('malformed top-level stream list returns an empty collection', async () => {
  const provider = new Provider(); provider.proxyFetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, streams: {} }) }));
  await expect(provider.getMatches()).resolves.toEqual([]);
});
