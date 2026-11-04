'use strict';
const BasketballVideoProvider = require('../src/providers/BasketballVideoProvider');

describe('BasketballVideo relative links', () => {
  test('resolves a relative media link against its replay page', async () => {
    const provider = new BasketballVideoProvider();
    provider.fetchPage.fire = jest.fn().mockResolvedValue('<a href="../video/game.mp4">Watch replay</a>');
    const streams = await provider.resolveStream('https://basketball-video.com/games/replay');
    expect(streams.map(s => s.url)).toEqual(['https://basketball-video.com/video/game.mp4']);
  });
  test('resolves a bridge iframe against the bridge page', async () => {
    const provider = new BasketballVideoProvider();
    provider.fetchPage.fire = jest.fn(async url => {
      if (url === 'https://basketball-video.com/games/replay') return '<a href="https://nbaontv.com/embed/123">Watch replay</a>';
      if (url === 'https://nbaontv.com/embed/123') return '<iframe src="../video/game.mp4"></iframe>';
      throw new Error(`Unexpected URL: ${url}`);
    });
    const streams = await provider.resolveStream('https://basketball-video.com/games/replay');
    expect(streams.map(s => s.url)).toEqual(['https://nbaontv.com/video/game.mp4']);
  });
  test('keeps a valid absolute URL while ignoring non-HTTP media links', async () => {
    const provider = new BasketballVideoProvider();
    provider.fetchPage.fire = jest.fn().mockResolvedValue('<a href="javascript:game.mp4">Watch</a><a href="https://cdn.example/game.m3u8">Watch</a>');
    const streams = await provider.resolveStream('https://basketball-video.com/games/replay');
    expect(streams.map(s => s.url)).toEqual(['https://cdn.example/game.m3u8']);
  });
  test.each(['https://nbaontv.com/embed/123', 'https://player.nbaontv.com/embed/123'])(
    'unwraps an actual nbaontv host: %s', async bridge => {
      const provider = new BasketballVideoProvider();
      provider.fetchPage.fire = jest.fn(async url => url === bridge
        ? '<iframe src="https://cdn.example/game.mp4"></iframe>'
        : `<a href="${bridge}">Watch replay</a>`);
      const streams = await provider.resolveStream('https://basketball-video.com/games/replay');
      expect(provider.fetchPage.fire).toHaveBeenCalledWith(bridge);
      expect(streams.map(s => s.url)).toEqual(['https://cdn.example/game.mp4']);
    }
  );
  test.each(['https://evil.example/nbaontv.com/embed', 'https://nbaontv.com.evil.example/embed', 'https://nbaontv.com@evil.example/embed'])(
    'does not treat an unrelated host as nbaontv: %s', async bridge => {
      const provider = new BasketballVideoProvider();
      provider.fetchPage.fire = jest.fn().mockResolvedValue(`<a href="${bridge}">Watch replay</a>`);
      await provider.resolveStream('https://basketball-video.com/games/replay');
      expect(provider.fetchPage.fire).toHaveBeenCalledTimes(1);
    }
  );
  test('finds a known media iframe after an unrelated iframe in a bridge', async () => {
    const provider = new BasketballVideoProvider();
    provider.fetchPage.fire = jest.fn(async url => url === 'https://nbaontv.com/embed/123'
      ? '<iframe src="https://ads.example/banner"></iframe><iframe src="https://cdn.example/game.mp4"></iframe>'
      : '<a href="https://nbaontv.com/embed/123">Watch replay</a>');
    expect((await provider.resolveStream('https://basketball-video.com/games/replay')).map(s => s.url)).toEqual(['https://cdn.example/game.mp4']);
  });
});
