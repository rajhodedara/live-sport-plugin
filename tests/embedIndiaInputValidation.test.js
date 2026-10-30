'use strict';
const EmbedIndiaProvider = require('../src/providers/EmbedIndiaProvider');

describe('EmbedIndia embed URL validation', () => {
  let provider;
  beforeEach(() => {
    provider = new EmbedIndiaProvider({});
    provider._tryWasmExtraction = jest.fn().mockResolvedValue(null);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  test.each(['httpbad', 'http://', 'httpx://example.com/watch', 123])('ignores invalid input %p without attempting extraction', async input => {
    await expect(provider.resolveStream(input, '', 'Game')).resolves.toEqual([]);
    expect(provider._tryWasmExtraction).not.toHaveBeenCalled();
  });
  test('keeps fallback options for a valid HTTPS embed', async () => {
    const streams = await provider.resolveStream('https://example.com/embed/42', '', 'Game');
    expect(provider._tryWasmExtraction).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(2);
    expect(streams[0].externalUrl).toContain('mode=extract');
    expect(streams[1].externalUrl).toContain('url=https%3A%2F%2Fexample.com%2Fembed%2F42');
  });
});
