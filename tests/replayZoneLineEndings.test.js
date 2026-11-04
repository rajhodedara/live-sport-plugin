'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({ request: jest.fn() }));
const { request } = require('../src/services/ProviderOutbound');
const ReplayZoneProvider = require('../src/providers/ReplayZoneProvider');

describe('ReplayZone replay feed', () => {
  test.each(['\n', '\r\n'])('preserves separate events with %j line endings', async (newline) => {
    const feed = [
      '# First match', '~basketball\tLeague\t\t2026-10-26', 'Part 1\thls\thttps://cdn.example/first.m3u8', '',
      '# Second match', '~hockey\tLeague\t\t2026-10-26', 'Part 1\thls\thttps://cdn.example/second.m3u8',
    ].join(newline);
    request.mockResolvedValue({ body: { text: async () => feed } });
    const matches = await new ReplayZoneProvider().getMatches();
    expect(matches.map(m => [m.title, m.sources[0].url])).toEqual([
      ['First match', 'https://cdn.example/first.m3u8'],
      ['Second match', 'https://cdn.example/second.m3u8'],
    ]);
    expect(matches.map(m => m.sources.length)).toEqual([1, 1]);
  });
});
