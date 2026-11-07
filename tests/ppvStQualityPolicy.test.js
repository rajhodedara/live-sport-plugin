'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(), streamingFetch: jest.fn()
}));
const PpvStProvider = require('../src/providers/PpvStProvider');
const { isLowTierValue, isLowPpvSourceMetadata } = require('../src/services/PpvQualityPolicy');
const { verifyStreams } = require('../src/streams');
const { safeFetch } = require('../src/services/ProviderOutbound');

describe('conservative PPV.st low-quality detection', () => {
  test.each(['540p', '540P60', '960x540', 'SD | Sky Sports F1', 'Sky Sports F1 [SD]', '480p', '360p'])(
    'recognizes an explicit low-quality marker: %s', text => {
      expect(isLowTierValue(text)).toBe(true);
    }
  );
  test.each(['HD | Sky Sports F1', '720p', '1080p', '4K | F1TV', 'Sky Sports F1', 'SD / HD Sky Sports F1', 'Brazilian GP', 'unknown'])(
    'does not invent lower-tier quality: %s', text => {
      expect(isLowTierValue(text)).toBe(false);
    }
  );
  test('event title alone cannot remove a useful provider feed', () => {
    expect(isLowPpvSourceMetadata({ name: 'SD Cup Finals', source_tag: 'Sky Sports F1' })).toBe(false);
    expect(isLowPpvSourceMetadata({ name: 'Sky Sports F1 [540p]' }, { includeName: true })).toBe(true);
  });
});

test('PPV.st catalog excludes labelled SD/540p variants but retains HD, 720p and unknown', async () => {
  const provider = new PpvStProvider();
  provider.proxyFetch = jest.fn(async () => ({
    ok: true, status: 200, json: async () => ({
      success: true, streams: [{
        category: 'Motorsport',
        streams: [{
          id: 'f1-event', name: 'São Paulo Grand Prix',
          starts_at: Math.floor(Date.now() / 1000),
          iframe: 'https://taifood-blog.asia/embed/main-sd',
          source_tag: 'SD | Sky Sports F1',
          substreams: [
            { id: 'sd', iframe: 'https://taifood-blog.asia/embed/low', source_tag: 'Sky Sports F1 [540p]', locale: 'en' },
            { id: 'hd', iframe: 'https://taifood-blog.asia/embed/high', source_tag: 'HD | Sky Sports F1', locale: 'en' },
            { id: '720', iframe: 'https://taifood-blog.asia/embed/720', source_tag: 'DAZN F1', resolution: '720p', locale: 'es' },
            { id: 'unknown', iframe: 'https://taifood-blog.asia/embed/unknown', source_tag: 'F1TV', locale: 'en' }
          ]
        }]
      }]
    })
  }));
  const matches = await provider.getMatches();
  expect(matches).toHaveLength(1);
  const sources = matches[0].sources;
  expect(sources.map(s => s.id)).toEqual(['hd', '720', 'unknown']);
  expect(sources[0]).toMatchObject({ channelName: 'HD | Sky Sports F1', language: 'en' });
  expect(sources[1].resolution).toBe('720p');
});

describe('verification of known PPV.st quality tiers', () => {
  let warn;
  beforeEach(() => {
    safeFetch.mockReset().mockResolvedValue({
      status: 200, ok: true,
      text: async () => '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n'
    });
    warn = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); });
  const raw = source => ({
    name: 'PitSport', _source: source,
    url: 'https://cdn.fixture.test/live.m3u8',
    behaviorHints: { notWebReady: true },
    resolution: 'HD'
  });
  const cache = () => ({ noteFailure: jest.fn(), noteSuccess: jest.fn() });
  const parser = tier => ({ parseManifestText: () => ({ resolution: tier, qualityTag: tier }) });

  test('a PPV.st media rendition verified at 540p is not advertised', async () => {
    const state = cache();
    const result = await verifyStreams([raw('ppvst')], 'ppvst:fixture:sd', parser('540p'), state, { skipSpeedProbe: true });
    expect(result).toEqual([]);
    expect(state.noteSuccess).not.toHaveBeenCalled();
  });
  test('720p PPV.st and 540p from unrelated providers retain their existing behavior', async () => {
    expect(await verifyStreams([raw('ppvst')], 'ppvst:fixture:hd', parser('720p'), cache(), { skipSpeedProbe: true })).toHaveLength(1);
    expect(await verifyStreams([raw('pitsport')], 'pitsport:fixture:a', parser('540p'), cache(), { skipSpeedProbe: true })).toHaveLength(1);
  });
});
