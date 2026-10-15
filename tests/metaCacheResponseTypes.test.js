const mockMatch = {
  id: 'meta-cache-types', title: 'Arsenal vs Chelsea', category: 'football',
  status: 'finished', date: '2026-09-18T19:00:00Z',
  sources: [{ source: 'replayzone', name: 'Full Match', url: 'https://example.com/replay' }]
};

jest.mock('../src/container', () => ({
  resolve: (name) => {
    if (name === 'cronService') return { ensureFresh: jest.fn() };
    if (name === 'cacheService') return { findMatch: () => mockMatch };
    throw new Error(`Unexpected service: ${name}`);
  }
}));
jest.mock('../src/streams', () => ({ prewarmMatch: jest.fn() }));

describe('meta cache response types', () => {
  test.each([['tv', 'series'], ['series', 'tv'], ['channel', 'series'], ['series', 'channel']])(
    '%s requests do not poison subsequent %s responses', async (first, second) => {
      jest.resetModules();
      const { handleMeta } = require('../src/catalog');
      const id = `nuvio_sport_${mockMatch.id}`;
      const config = { timezone: 'UTC' };
      const a = await handleMeta(first, id, config);
      const b = await handleMeta(second, id, config);
      for (const [requested, response] of [[first, a], [second, b]]) {
        const series = requested === 'series';
        expect(response.meta.type).toBe(series ? 'series' : 'tv');
        expect(response.meta.posterShape).toBe(series ? 'regular' : 'landscape');
        expect(response.meta.behaviorHints.defaultVideoId).toBe(series ? `${id}:1:1` : id);
        if (series) expect(response.meta.videos).toHaveLength(1);
        else expect(response.meta.videos).toBeUndefined();
        // Cache reuse must preserve the same correct shape on repeated calls.
        expect(await handleMeta(requested, id, config)).toEqual(response);
      }
    }
  );
});
