'use strict';

/**
 * Regression test suite for language filtering and customization across:
 * 1. Cartoon Network (multi-region 24/7 channel)
 * 2. Sky Sports F1 (motorsport 24/7 channel / events)
 * 3. Golf (Sky Sports Golf channel & live Golf event fixtures)
 */

jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/TimingRuntime', () => ({
  relations: { stream: jest.fn(() => null), endWindow: jest.fn() }
}));

const container = require('../src/container');
const { handleStream } = require('../src/streams');
const StreamResolveCache = require('../src/services/StreamResolveCache');

function feed(id, overrides = {}) {
  return {
    url: `https://cdn.test/${id}.m3u8`,
    title: `Stream ${id}`,
    _source: 'vavoo',
    ...overrides
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setupMockMatch(match, streamRowsBySourceId) {
  const sources = match.sources || Object.keys(streamRowsBySourceId).map(id => ({ source: 'vavoo', id }));
  const matchWithSources = { ...match, sources };
  const controls = Object.fromEntries(sources.map(src => [src.id, deferred()]));
  const cache = new StreamResolveCache({
    sharedResolver: { available: () => false, request: () => { throw Error('Unexpected'); } }
  });

  for (const [id, row] of Object.entries(streamRowsBySourceId)) {
    const src = sources.find(s => s.id === id);
    if (src) {
      cache._set(StreamResolveCache.resolveKey(src, matchWithSources.id), src.source, matchWithSources.id, [row], 'ok', 60000);
    }
  }

  const provider = { resolveStream: jest.fn(id => controls[id]?.promise || Promise.resolve([])) };
  container.resolve.mockImplementation(name => ({
    cacheService: { findMatch: () => matchWithSources },
    streamResolveCache: cache,
    streamScorer: { calculateScore: () => 1 },
    m3u8Parser: null,
    vavooProvider: provider,
    daddyLiveProvider: provider,
    scorezoneProvider: provider
  })[name]);

  return { id: `nuvio_sport_${matchWithSources.id}`, match: matchWithSources, controls, cache };
}

describe('Channel & Sport Language Regression Tests', () => {
  beforeEach(() => {
    process.env.DONATION_URL = 'disabled';
    jest.clearAllMocks();
  });

  describe('Cartoon Network (Multi-Region 24/7 Channel)', () => {
    const match = {
      id: 'vavoo_ch_cartoon_network',
      title: 'Cartoon Network',
      category: 'networks',
      isChannel: true,
      sources: [
        { source: 'vavoo', id: 'cn-uk' },
        { source: 'vavoo', id: 'cn-es' },
        { source: 'vavoo', id: 'cn-ar' },
        { source: 'vavoo', id: 'cn-de' },
        { source: 'vavoo', id: 'cn-it' },
        { source: 'vavoo', id: 'cn-unk' },
      ]
    };

    const streams = {
      'cn-uk': feed('cn-uk', { channelName: 'Cartoon Network UK', group: 'United Kingdom', language: 'English' }),
      'cn-es': feed('cn-es', { channelName: 'Cartoon Network Spain', group: 'Spain', language: 'Spanish' }),
      'cn-ar': feed('cn-ar', { channelName: 'Cartoon Network Arabic', group: 'Arabia', language: 'Arabic' }),
      'cn-de': feed('cn-de', { channelName: 'Cartoon Network Germany', group: 'Germany', language: 'German' }),
      'cn-it': feed('cn-it', { channelName: 'Cartoon Network Italy', group: 'Italy', language: 'Italian' }),
      'cn-unk': feed('cn-unk', { channelName: 'Cartoon Network', group: 'General' }), // unclassified
    };

    it('Show all languages: Arabic prioritized first, then Spanish (English remains top rank in default tiers)', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'Arabic,Spanish',
        languageFilter: 'all'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toContain('https://cdn.test/cn-uk.m3u8');
      expect(urls).toContain('https://cdn.test/cn-ar.m3u8');
      expect(urls).toContain('https://cdn.test/cn-es.m3u8');
      expect(urls).toContain('https://cdn.test/cn-unk.m3u8');
      expect(urls).toContain('https://cdn.test/cn-de.m3u8');

      // Rank order: English (0) -> Arabic (1) -> Spanish (2) -> Unknown (3) -> other known (4)
      const ukIdx = urls.indexOf('https://cdn.test/cn-uk.m3u8');
      const arIdx = urls.indexOf('https://cdn.test/cn-ar.m3u8');
      const esIdx = urls.indexOf('https://cdn.test/cn-es.m3u8');
      const unkIdx = urls.indexOf('https://cdn.test/cn-unk.m3u8');
      const deIdx = urls.indexOf('https://cdn.test/cn-de.m3u8');

      expect(ukIdx).toBeLessThan(arIdx);
      expect(arIdx).toBeLessThan(esIdx);
      expect(esIdx).toBeLessThan(unkIdx);
      expect(unkIdx).toBeLessThan(deIdx);
    });

    it('Strict mode (Only selected languages): Spanish only keeps Spanish and unknown streams', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'Spanish',
        languageFilter: 'only'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toEqual([
        'https://cdn.test/cn-es.m3u8',
        'https://cdn.test/cn-unk.m3u8',
      ]);
      expect(urls).not.toContain('https://cdn.test/cn-uk.m3u8');
      expect(urls).not.toContain('https://cdn.test/cn-ar.m3u8');
      expect(urls).not.toContain('https://cdn.test/cn-de.m3u8');
      expect(urls).not.toContain('https://cdn.test/cn-it.m3u8');
    });

    it('Strict mode (Only selected languages): Arabic & Italian keeps Arabic, Italian, and unknown streams', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'ar,it',
        languageFilter: 'only'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toContain('https://cdn.test/cn-ar.m3u8');
      expect(urls).toContain('https://cdn.test/cn-it.m3u8');
      expect(urls).toContain('https://cdn.test/cn-unk.m3u8');
      expect(urls).not.toContain('https://cdn.test/cn-uk.m3u8');
      expect(urls).not.toContain('https://cdn.test/cn-es.m3u8');
      expect(urls).not.toContain('https://cdn.test/cn-de.m3u8');
    });

    it('Empty selection in strict mode: shows all streams with default ordering', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'none',
        languageFilter: 'only'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toHaveLength(6);
      expect(urls[0]).toBe('https://cdn.test/cn-uk.m3u8'); // English first
    });
  });

  describe('Sky Sports F1 (24/7 Channel & Event)', () => {
    const match = {
      id: 'vavoo_ch_sky_sports_f1',
      title: 'Sky Sports F1',
      category: 'networks',
      isChannel: true,
      sources: [
        { source: 'vavoo', id: 'f1-uk' },
        { source: 'vavoo', id: 'f1-it' },
        { source: 'vavoo', id: 'f1-de' },
        { source: 'vavoo', id: 'f1-unk' },
      ]
    };

    const streams = {
      'f1-uk': feed('f1-uk', { channelName: 'UK | SKY SPORTS F1', group: 'United Kingdom', language: 'English' }),
      'f1-it': feed('f1-it', { channelName: 'IT | Sky Sport F1', group: 'Italy', language: 'Italian' }),
      'f1-de': feed('f1-de', { channelName: 'DE | Sky Sport F1', group: 'Germany', language: 'German' }),
      'f1-unk': feed('f1-unk', { channelName: 'F1 Live Stream', group: 'Racing' }),
    };

    it('Show all languages: German ranked before Italian when specified', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'German,Italian',
        languageFilter: 'all'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toHaveLength(4);
      const deIdx = urls.indexOf('https://cdn.test/f1-de.m3u8');
      const itIdx = urls.indexOf('https://cdn.test/f1-it.m3u8');
      expect(deIdx).toBeLessThan(itIdx);
    });

    it('Strict mode: Italian only filters English and German but keeps Italian and unclassified', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'Italian',
        languageFilter: 'only'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toEqual([
        'https://cdn.test/f1-it.m3u8',
        'https://cdn.test/f1-unk.m3u8',
      ]);
      expect(urls).not.toContain('https://cdn.test/f1-uk.m3u8');
      expect(urls).not.toContain('https://cdn.test/f1-de.m3u8');
    });

    it('Strict mode: English only keeps English and unclassified', async () => {
      const { id } = setupMockMatch(match, streams);
      const res = await handleStream('channel', id, {
        liveLanguages: 'English',
        languageFilter: 'only'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toEqual([
        'https://cdn.test/f1-uk.m3u8',
        'https://cdn.test/f1-unk.m3u8',
      ]);
      expect(urls).not.toContain('https://cdn.test/f1-it.m3u8');
      expect(urls).not.toContain('https://cdn.test/f1-de.m3u8');
    });
  });

  describe('Golf (Live Fixture & Sky Sports Golf Channel)', () => {
    const liveGolfMatch = {
      id: 'golf_pga_tour_2026',
      title: 'PGA Tour - The Masters Round 2',
      category: 'golf',
      date: String(Date.now() + 3600000),
      sources: [
        { source: 'vavoo', id: 'golf-uk' },
        { source: 'vavoo', id: 'golf-us' },
        { source: 'vavoo', id: 'golf-es' },
        { source: 'vavoo', id: 'golf-fr' },
        { source: 'vavoo', id: 'golf-unk' },
      ]
    };

    const golfStreams = {
      'golf-uk': feed('golf-uk', { channelName: 'Sky Sports Golf', group: 'United Kingdom', language: 'English' }),
      'golf-us': feed('golf-us', { channelName: 'Golf Channel USA', group: 'USA', language: 'English' }),
      'golf-es': feed('golf-es', { channelName: 'Movistar Golf', group: 'Spain', language: 'Spanish' }),
      'golf-fr': feed('golf-fr', { channelName: 'Canal+ Golf', group: 'France', language: 'French' }),
      'golf-unk': feed('golf-unk', { channelName: 'Golf Live 1', group: 'Sports' }),
    };

    it('Live Golf fixture in strict mode with Spanish only: keeps Spanish and unclassified, excludes English and French', async () => {
      const { id } = setupMockMatch(liveGolfMatch, golfStreams);
      const res = await handleStream('tv', id, {
        liveLanguages: 'Spanish',
        languageFilter: 'only'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toEqual([
        'https://cdn.test/golf-es.m3u8',
        'https://cdn.test/golf-unk.m3u8',
      ]);
      expect(urls).not.toContain('https://cdn.test/golf-uk.m3u8');
      expect(urls).not.toContain('https://cdn.test/golf-us.m3u8');
      expect(urls).not.toContain('https://cdn.test/golf-fr.m3u8');
    });

    it('Live Golf fixture in Show all languages with French, Spanish: English first, then French, then Spanish, then unclassified', async () => {
      const { id } = setupMockMatch(liveGolfMatch, golfStreams);
      const res = await handleStream('tv', id, {
        liveLanguages: 'French,Spanish',
        languageFilter: 'all'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toHaveLength(5);
      const frIdx = urls.indexOf('https://cdn.test/golf-fr.m3u8');
      const esIdx = urls.indexOf('https://cdn.test/golf-es.m3u8');
      const unkIdx = urls.indexOf('https://cdn.test/golf-unk.m3u8');

      expect(frIdx).toBeLessThan(esIdx);
      expect(esIdx).toBeLessThan(unkIdx);
    });

    it('Legacy languages fallback when liveLanguages is absent: respects legacy configuration on Golf fixture', async () => {
      const { id } = setupMockMatch(liveGolfMatch, golfStreams);
      const res = await handleStream('tv', id, {
        languages: 'Spanish,French'
      });

      const urls = res.streams.map(s => s.url);
      expect(urls).toHaveLength(5);
      const esIdx = urls.indexOf('https://cdn.test/golf-es.m3u8');
      const frIdx = urls.indexOf('https://cdn.test/golf-fr.m3u8');
      expect(esIdx).toBeLessThan(frIdx);
    });
  });
});
