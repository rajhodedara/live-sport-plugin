'use strict';

const undici = require('undici');
const ReplayZoneProvider = require('../src/providers/ReplayZoneProvider');

describe('ReplayZoneProvider - Dailymotion Handling', () => {
  let provider;

  beforeEach(() => {
    provider = new ReplayZoneProvider();
  });

  test('identifies Dailymotion URLs correctly', () => {
    expect(provider._isDailymotionUrl('https://geo.dailymotion.com/player.html?video=xb73252')).toBe(true);
    expect(provider._isDailymotionUrl('https://www.dailymotion.com/video/xba6mva')).toBe(true);
    expect(provider._isDailymotionUrl('https://www.dailymotion.com/embed/video/xba6mva')).toBe(true);
    expect(provider._isDailymotionUrl('https://dai.ly/xba6mva')).toBe(true);
    expect(provider._isDailymotionUrl('https://ok.ru/videoembed/123')).toBe(false);
    expect(provider._isDailymotionUrl('https://bysefujedu.com/d/123')).toBe(false);
  });

  test('extracts Dailymotion video IDs accurately', () => {
    expect(provider._extractDailymotionVideoId('https://geo.dailymotion.com/player.html?video=xb73252')).toBe('xb73252');
    expect(provider._extractDailymotionVideoId('https://www.dailymotion.com/video/xba6mva')).toBe('xba6mva');
    expect(provider._extractDailymotionVideoId('https://www.dailymotion.com/embed/video/xba6mva?autoplay=1')).toBe('xba6mva');
    expect(provider._extractDailymotionVideoId('https://dai.ly/xba6mva')).toBe('xba6mva');
    expect(provider._extractDailymotionVideoId('https://example.com/other')).toBeNull();
  });

  test('drops dead Dailymotion streams when metadata returns error', async () => {
    const mockRequest = jest.spyOn(undici, 'request').mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          error: {
            title: 'Content rejected.',
            message: 'This video has been removed due to a breach of the Terms of Use.',
            code: 'DM005',
            status_code: 410
          }
        })
      }
    });

    const streams = await provider.resolveStream('https://geo.dailymotion.com/player.html?video=xb73252', 'motorsport', 'Formula 1');
    expect(streams).toEqual([]);
    expect(provider._getCachedDm('xb73252')).toBe(false);

    mockRequest.mockRestore();
  });

  test('drops dead Dailymotion streams when qualities are missing', async () => {
    const mockRequest = jest.spyOn(undici, 'request').mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          title: 'Empty Video'
        })
      }
    });

    const streams = await provider.resolveStream('https://geo.dailymotion.com/player.html?video=empty123', 'motorsport', 'Formula 1');
    expect(streams).toEqual([]);
    expect(provider._getCachedDm('empty123')).toBe(false);

    mockRequest.mockRestore();
  });

  test('returns external stream for active Dailymotion video', async () => {
    const mockRequest = jest.spyOn(undici, 'request').mockResolvedValueOnce({
      statusCode: 200,
      body: {
        json: async () => ({
          qualities: {
            auto: [{ type: 'application/x-mpegURL', url: 'https://cdndirector.dailymotion.com/cdn/manifest/video/live123.m3u8' }]
          }
        })
      }
    });

    const streams = await provider.resolveStream('https://geo.dailymotion.com/player.html?video=live123', 'motorsport', 'Formula 1', { name: 'Server 3 (DM)' });
    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('RZ (External)');
    expect(streams[0].title).toBe('Server 3 (Browser)');
    expect(streams[0].externalUrl).toBe('https://geo.dailymotion.com/player.html?video=live123');
    expect(provider._getCachedDm('live123')).toBe(true);

    mockRequest.mockRestore();
  });

  test('uses cached status without querying network again', async () => {
    provider._setCachedDm('cachedDead', false);
    const mockRequest = jest.spyOn(undici, 'request');

    const streams = await provider.resolveStream('https://geo.dailymotion.com/player.html?video=cachedDead', 'motorsport', 'Formula 1');
    expect(streams).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();

    mockRequest.mockRestore();
  });
});
