'use strict';

jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const { safeFetch } = require('../src/impitClient');
const LiveTVProvider = require('../src/providers/LiveTVProvider');

describe('LiveTV replay iframe resolution', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    safeFetch.mockReset();
    global.fetch = jest.fn().mockResolvedValue({ status: 200 });
  });
  afterEach(() => { global.fetch = originalFetch; });

  test.each(['/video/player', '../video/player'])('resolves relative iframe %s against the embedding page', async (iframe) => {
    safeFetch.mockImplementation(async (url) => {
      const pages = {
        'https://livetv.sx/enx/showvideo/123': '<meta property="og:video" content="https://embed.example/nested/page">',
        'https://embed.example/nested/page': `<iframe src="${iframe}"></iframe>`,
        'https://embed.example/video/player': '<source src="https://cdn.example/replay.mp4">',
      };
      if (!pages[url]) throw new Error(`Unexpected URL ${url}`);
      return { ok: true, text: async () => pages[url] };
    });
    const streams = await new LiveTVProvider().resolveStream('/enx/showvideo/123');
    expect(streams).toEqual(expect.arrayContaining([expect.objectContaining({ url: 'https://cdn.example/replay.mp4' })]));
    expect(safeFetch).toHaveBeenCalledWith('https://embed.example/video/player', expect.any(Object));
  });

  test('keeps looking for a video source when an iframe URL is malformed', async () => {
    safeFetch.mockImplementation(async (url) => {
      const pages = {
        'https://livetv.sx/enx/showvideo/123': '<meta property="og:video" content="https://embed.example/nested/page">',
        'https://embed.example/nested/page': '<iframe src="http://["></iframe><source src="https://cdn.example/replay.mp4">',
      };
      if (!pages[url]) throw new Error(`Unexpected URL ${url}`);
      return { ok: true, text: async () => pages[url] };
    });
    const streams = await new LiveTVProvider().resolveStream('/enx/showvideo/123');
    expect(streams).toEqual(expect.arrayContaining([expect.objectContaining({ url: 'https://cdn.example/replay.mp4' })]));
  });
});
