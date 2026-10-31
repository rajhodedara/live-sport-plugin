'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/impitClient');
const FullRacesProvider = require('../src/providers/FullRacesProvider');
beforeEach(() => safeFetch.mockReset());

test('FullRaces HTML uses the guarded browser path rather than obtaining a raw native client', async () => {
  safeFetch.mockResolvedValue({ status: 200, text: async () => '<html>fixture</html>' });
  const provider = new FullRacesProvider();
  expect(await provider._fetchHtml('https://fullraces.com/fixture')).toBe('<html>fixture</html>');
  expect(safeFetch.mock.calls[0][1]).toMatchObject({ guardExternal: true, attempts: 1, timeoutMs: 10000 });
});
test('FullRaces keeps its alternate HTTP client check for a non-403 native verdict', async () => {
  safeFetch.mockResolvedValueOnce({ status: 404 });
  safeFetch.mockResolvedValueOnce({ status: 200, headers: {}, arrayBuffer: async () => Uint8Array.from(Buffer.from('alternate')).buffer });
  const provider = new FullRacesProvider();
  expect(await provider._fetchHtml('https://fullraces.com/fixture')).toBe('alternate');
  expect(safeFetch.mock.calls[1][1]).toMatchObject({ guardExternal: true, transport: 'undici', redirect: 'manual' });
});
test('FullRaces cannot bypass the guard by falling through to its alternate client', async () => {
  const failure = Object.assign(new Error('Blocked'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
  safeFetch.mockRejectedValue(failure);
  await expect(new FullRacesProvider()._fetchHtml('http://127.0.0.1/private')).rejects.toBe(failure);
  expect(safeFetch).toHaveBeenCalledTimes(1);
});
