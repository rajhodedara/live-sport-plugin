'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const MlbLiveProvider = require('../src/providers/MlbLiveProvider');

describe('MLBLive relative stream links', () => {
  test('does not prioritize an unrelated hostname containing a known player name', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn(async url => url.endsWith('/bridge/123')
      ? '<iframe src="https://vidara.so.attacker.example/embed"></iframe><iframe src="../video/game.mp4"></iframe>'
      : '<a href="../bridge/123">Watch</a>');
    provider._extractVidara = jest.fn().mockResolvedValue([]);
    expect((await provider.resolveStream('https://mlblive.net/games/replay')).map(s => s.url)).toEqual(['https://mlblive.net/video/game.mp4']);
    expect(provider._extractVidara).not.toHaveBeenCalled();
  });
  test('finds a media iframe after an unrelated bridge iframe', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn(async url => url.endsWith('/bridge/123')
      ? '<iframe src="https://ads.example/banner"></iframe><iframe src="../video/game.mp4"></iframe>'
      : '<a href="../bridge/123">Watch</a>');
    expect((await provider.resolveStream('https://mlblive.net/games/replay')).map(s => s.url)).toEqual(['https://mlblive.net/video/game.mp4']);
  });
  test('continues to the next replay when one extractor fails', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn().mockResolvedValue('<a href="https://byse.example/embed/1">Watch</a><a href="https://cdn.example/game.mp4">Watch</a>');
    provider._extractByse = jest.fn().mockRejectedValue(new Error('fixture extractor failed'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { expect((await provider.resolveStream('https://mlblive.net/games/replay')).map(s => s.url)).toEqual(['https://cdn.example/game.mp4']); }
    finally { log.mockRestore(); }
  });
  test('resolves media links against the replay page', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn().mockResolvedValue('<a href="../video/game.mp4">Watch replay</a>');
    const streams = await provider.resolveStream('https://mlblive.net/games/replay');
    expect(streams.map(s => s.url)).toEqual(['https://mlblive.net/video/game.mp4']);
  });
  test('resolves a relative bridge and iframe from their respective pages', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn(async url => {
      if (url === 'https://mlblive.net/games/replay') return '<a href="../bridge/123">Watch</a>';
      if (url === 'https://mlblive.net/bridge/123') return '<iframe src="../video/game.m3u8"></iframe>';
      throw new Error(`Unexpected URL: ${url}`);
    });
    const streams = await provider.resolveStream('https://mlblive.net/games/replay');
    expect(streams.map(s => s.url)).toEqual(['https://mlblive.net/video/game.m3u8']);
  });
  test('retains absolute media URLs and ignores non-HTTP links', async () => {
    const provider = new MlbLiveProvider();
    provider.fetchPage.fire = jest.fn().mockResolvedValue('<a href="javascript:game.mp4">Watch</a><a href="https://cdn.example/game.mp4">Watch</a>');
    const streams = await provider.resolveStream('https://mlblive.net/games/replay');
    expect(streams.map(s => s.url)).toEqual(['https://cdn.example/game.mp4']);
  });
});
