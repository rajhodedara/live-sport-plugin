'use strict';
const fs = require('fs');
const YamlProviderBuilder = require('../src/services/YamlProviderBuilder');

describe('YAML provider event links', () => {
  let provider;
  beforeEach(() => {
    const originalRead = fs.readFileSync;
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['example.yml']);
    jest.spyOn(fs, 'readFileSync').mockImplementation((name, ...args) => String(name).endsWith('/providers/yaml/example.yml')
      ? `name: Sample\nbaseUrl: https://example.com/sports/index\nselectors:\n  matches: .event\n  title: .title\n  link: a -> href\n`
      : originalRead(name, ...args));
    const circuitBreaker = { wrapSync: () => ({ fire: jest.fn() }) };
    provider = new YamlProviderBuilder().buildProviders(null, circuitBreaker)[0];
  });
  afterEach(() => jest.restoreAllMocks());
  test('skips a missing link and keeps a later valid event', async () => {
    provider.fetchData.fire.mockResolvedValue('<div class="event"><b class="title">Broken</b><a>Watch</a></div><div class="event"><b class="title">Game</b><a href="../watch/1">Watch</a></div>');
    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('Game');
    expect(matches[0].sources[0].url).toBe('https://example.com/watch/1');
    const streams = await provider.resolveStream(matches[0].sources[0].id, '', 'Game');
    expect(streams[0].externalUrl).toBe('https://example.com/watch/1');
  });
  test.each([undefined, '', 'javascript:alert(1)'])('rejects invalid source %p gracefully', async source => {
    await expect(provider.resolveStream(source, '', 'Game')).resolves.toEqual([]);
  });
});
