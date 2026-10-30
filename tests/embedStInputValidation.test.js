'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/impitClient');
const EmbedStProvider = require('../src/providers/EmbedStProvider');

describe('EmbedSt embed URL validation', () => {
  let provider;
  let priorWasm;
  beforeEach(() => {
    priorWasm = process.env.ENABLE_WASM;
    process.env.ENABLE_WASM = 'false';
    provider = new EmbedStProvider({ streamedWasmPool: { resolveWasmStream: jest.fn() } });
    safeFetch.mockReset();
    safeFetch.mockResolvedValue({ text: async () => '<html></html>' });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (priorWasm === undefined) delete process.env.ENABLE_WASM;
    else process.env.ENABLE_WASM = priorWasm;
    jest.restoreAllMocks();
  });
  test.each(['httpbad', 'http://', 'httpx://example.com/watch', 123])('ignores invalid input %p before prefetch', async input => {
    await expect(provider.resolveStream(input, '', 'Game')).resolves.toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(provider.streamedWasmPool.resolveWasmStream).not.toHaveBeenCalled();
  });
  test('keeps a fallback for a valid HTTPS embed', async () => {
    const streams = await provider.resolveStream('https://example.com/embed/42', '', 'Game');
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain('url=https%3A%2F%2Fexample.com%2Fembed%2F42');
  });
});
