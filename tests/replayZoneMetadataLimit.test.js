'use strict';
jest.mock('../src/services/ProviderOutbound', () => ({ request: jest.fn() }));
const { request } = require('../src/services/ProviderOutbound');
const ReplayZoneProvider = require('../src/providers/ReplayZoneProvider');

test('accepts a complete replay index larger than the default metadata cap', async () => {
  const padding = 'x'.repeat(1024 * 1024 + 1);
  request.mockResolvedValueOnce({ bodyTruncated: false, body: { text: async () => `# Example\n~ basketball\tLeague\t\t2026-01-01\nWatch\thls\thttps://cdn.example.org/master.m3u8\n\n${padding}` } });
  const matches = await new ReplayZoneProvider().getMatches();
  expect(matches).toHaveLength(1);
  expect(request.mock.calls[0][1].maxBodyBytes).toBe(8 * 1024 * 1024);
});

test('does not parse a truncated replay index', async () => {
  const body = { text: jest.fn() };
  request.mockResolvedValueOnce({ bodyTruncated: true, body });
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { expect(await new ReplayZoneProvider().getMatches()).toEqual([]); expect(body.text).not.toHaveBeenCalled(); }
  finally { log.mockRestore(); }
});
