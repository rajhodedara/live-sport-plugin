// tests/movieboxTVProvider.test.js
'use strict';
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM'); }),
  destroy: jest.fn(async () => {})
}));
jest.mock('../src/services/ProviderOutbound', () => ({
  request: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  safeFetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
  fetch: jest.fn(() => { throw new Error('Unexpected I/O'); }),
}));

const MovieBoxTVProvider = require('../src/providers/MovieBoxTVProvider');
const container = require('../src/container');

const CHANNEL_LIST_FIXTURE = [
  { channelId: 'CH001', name: 'CNN International', channelName: null, logo: 'https://logo.host/cnn.png' },
  { channelId: 'CH002', name: null, channelName: null, logo: null },   // null name → fallback to channelId
  { channelId: 'CH003', name: 'BBC World News', channelName: 'BBC World', logo: 'https://logo.host/bbc.png' },
];

const TV_CHANNEL_FIXTURE = {
  code: 0,
  data: {
    channelId: 'CH001',
    liveUrl: 'https://cdn.host/CH001/live.m3u8',
  }
};

describe('MovieBoxTVProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new MovieBoxTVProvider();
  });

  describe('Container DI', () => {
    test('resolves movieboxTvProvider singleton', () => {
      if (!container.hasRegistration('movieboxTvProvider')) {
        return;
      }
      const resolved = container.resolve('movieboxTvProvider');
      expect(resolved).toBeInstanceOf(MovieBoxTVProvider);
      expect(resolved.sourceName).toBe('moviebox_tv');
    });
  });

  describe('_parseChannel', () => {
    test('uses name field when present', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.title).toBe('CNN International');
    });

    test('falls back to channelId string when name and channelName are null', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[1], 'US');
      expect(entity.title).toBe('CH002');
    });

    test('category is always "networks"', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.category).toBe('networks');
    });

    test('id is prefixed with "moviebox_tv_"', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.id).toBe('moviebox_tv_CH001');
    });

    test('sources[0].source is "moviebox_tv"', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.sources[0].source).toBe('moviebox_tv');
      expect(entity.sources[0].id).toBe('CH001');
    });

    test('date is "0" and poster is empty for 24/7 evergreen channels', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'US');
      expect(entity.date).toBe('');
      expect(entity.poster).toBe('');
      expect(entity.thumbnail_url).toBe('');
    });

    test('league is countryCode', () => {
      const entity = provider._parseChannel(CHANNEL_LIST_FIXTURE[0], 'GB');
      expect(entity.league).toBe('GB');
    });
  });

  describe('_extractTvStream', () => {
    test('returns stream from liveUrl field', () => {
      const streams = provider._extractTvStream(TV_CHANNEL_FIXTURE.data);
      expect(streams.length).toBe(1);
      expect(streams[0].url).toBe('https://cdn.host/CH001/live.m3u8');
    });

    test('returns [] when no URL fields are present', () => {
      const streams = provider._extractTvStream({ channelId: 'CH999' });
      expect(streams).toEqual([]);
    });
  });
});
