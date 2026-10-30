'use strict';
const mockDialed = [];
const mockAttempts = [];
jest.mock('../src/impitClient', () => ({
  safeFetch: async (url, options) => {
    mockAttempts.push({ url, options });
    if (options.guardExternal !== true) throw new Error('unguarded fetch');
    const { assertOutboundUrl } = require('../src/services/GuardedOutbound');
    await assertOutboundUrl(url, { resolve: async () => ['8.8.8.8'] });
    mockDialed.push(url);
    return { status: 200, text: async () => '<a href="http://127.0.0.1/admin">Watch</a><a href="https://media.example.org/movie.mp4">Watch</a>' };
  }
}));
const MlbLiveProvider = require('../src/providers/MlbLiveProvider');

test('a private bridge is rejected by the guard without discarding a later replay', async () => {
  const provider = new MlbLiveProvider();
  const result = await provider.resolveStream('https://replay.example.org/games/123');
  expect(mockAttempts.some(x => x.url === 'http://127.0.0.1/admin')).toBe(true);
  expect(mockAttempts.every(x => x.options.guardExternal === true)).toBe(true);
  expect(mockDialed).toEqual(['https://replay.example.org/games/123']);
  expect(result.map(x => x.url)).toContain('https://media.example.org/movie.mp4');
});
