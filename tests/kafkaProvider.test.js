'use strict';

const KafkaProvider = require('../src/providers/KafkaProvider');

// ── Redacted Deterministic Fixtures ──────────────────────────────────────────

const REDACTED_MANIFEST_URL = 'https://flixnest.stream/u/REDACTED_BEARER_TOKEN/manifest.json';

const MOCK_MANIFEST = {
  id: 'org.flix.livetv',
  version: '2.0.0',
  name: 'Flix Live TV',
  description: 'Flix Live TV Addon',
  resources: ['catalog', 'stream'],
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'flix-live-tv-v2-trex',
      name: 'Flix Live TV (Trex)',
      extra: [{ name: 'skip' }, { name: 'search' }]
    },
    {
      type: 'tv',
      id: 'flix-live-tv-v2-trex-cat-wc-world-cricket',
      name: 'World Cricket',
      extra: [{ name: 'skip' }]
    },
    {
      type: 'tv',
      id: 'flix-live-tv-v2-trex-cat-uk-scottish-football',
      name: 'UK Scottish Football',
      extra: [{ name: 'skip' }]
    },
    {
      type: 'tv',
      id: 'flix-live-tv-v2-trex-cat-entertainment-general',
      name: 'General Entertainment',
      extra: [{ name: 'skip' }]
    }
  ]
};

const MOCK_SPORTS_CATALOG_PAGE = {
  metas: [
    {
      id: 'flix:wc-sky-cricket-hd',
      type: 'tv',
      name: 'Sky Sports Cricket HD',
      poster: 'https://cdn.example.invalid/posters/sky_cricket.png',
      genres: ['Cricket', 'Sports']
    },
    {
      id: 'flix:wc-willow-usa',
      type: 'tv',
      name: 'Willow Cricket HD (US)',
      poster: 'https://cdn.example.invalid/posters/willow.png',
      genres: ['Cricket', 'Sports']
    }
  ]
};

const MOCK_STREAM_RESPONSE = {
  streams: [
    {
      name: 'Flix [1080p]',
      title: 'Sky Sports Cricket HD - 1080p',
      url: 'https://edge-cdn.example.invalid/live/sky_cricket/master.m3u8',
      behaviorHints: {
        proxyHeaders: {
          request: {
            'User-Agent': 'Mozilla/5.0'
          }
        }
      }
    }
  ]
};

const MOCK_TAXONOMY_DREAM4K = [
  { name: 'US ESPN+', slug: 'us-espn-plus', count: 399 },
  { name: 'DAZN Switzerland PPV', slug: 'dazn-switzerland-ppv', count: 350 },
  { name: 'US FloSports', slug: 'us-flosports', count: 279 }
];

const MOCK_TAXONOMY_DINO = [
  { name: 'USA Flo PPV', slug: 'usa-flo-ppv', count: 1000 },
  { name: 'USA ESPN+', slug: 'usa-espn-plus', count: 500 },
  { name: 'UK World Sports', slug: 'uk-world-sports', count: 196 }
];

const MOCK_TAXONOMY_CLOUD = [
  { name: 'BeIN Sports', slug: 'bein-sports', count: 354 },
  { name: 'French Soccer PPV', slug: 'french-soccer-ppv', count: 201 },
  { name: 'TSN Sports', slug: 'tsn-sports', count: 104 }
];

describe('KafkaProvider - Task 1: Upstream Contract and Provider Seam', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Metadata and configuration', () => {
    test('exposes canonical provider identity and leaf getMatches contract', async () => {
      const provider = new KafkaProvider({});
      expect(provider.name).toBe('Kafka');
      expect(provider.sourceName).toBe('kafka');
      expect(typeof provider.getMatches).toBe('function');
      const matches = await provider.getMatches();
      expect(matches).toEqual([]);
    });

    test('configured flag requires both KAFKA_ENABLED=true and valid manifest URL', () => {
      delete process.env.KAFKA_ENABLED;
      delete process.env.KAFKA_MANIFEST_URL;
      const p1 = new KafkaProvider({});
      expect(p1.configured).toBe(false);

      process.env.KAFKA_ENABLED = 'true';
      const p2 = new KafkaProvider({});
      expect(p2.configured).toBe(false);

      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      const p3 = new KafkaProvider({});
      expect(p3.configured).toBe(true);

      process.env.KAFKA_ENABLED = 'false';
      const p4 = new KafkaProvider({});
      expect(p4.configured).toBe(false);
    });
  });

  describe('Manifest URL validation and secret hygiene', () => {
    test('validates manifest URL syntax and rejects insecure or malformed URLs', () => {
      const provider = new KafkaProvider({});

      // Valid HTTPS
      expect(provider.validateManifestUrl('https://flixnest.stream/u/abc123xyz/manifest.json')).toBe(true);

      // Insecure HTTP rejected
      expect(provider.validateManifestUrl('http://flixnest.stream/u/abc123xyz/manifest.json')).toBe(false);

      // Embedded credentials rejected
      expect(provider.validateManifestUrl('https://user:pass@flixnest.stream/u/abc123xyz/manifest.json')).toBe(false);

      // Missing manifest.json suffix rejected
      expect(provider.validateManifestUrl('https://flixnest.stream/u/abc123xyz')).toBe(false);
      expect(provider.validateManifestUrl('https://flixnest.stream/u/abc123xyz/catalog.json')).toBe(false);

      // Non-URL strings rejected
      expect(provider.validateManifestUrl('not-a-url')).toBe(false);
      expect(provider.validateManifestUrl('')).toBe(false);
      expect(provider.validateManifestUrl(null)).toBe(false);
    });

    test('safe logging helper redacts path token and never exposes secrets', () => {
      const provider = new KafkaProvider({});
      const safe = provider.getSafeLogUrl('https://flixnest.stream/u/super-secret-bearer-token/manifest.json');
      expect(safe).toBe('https://flixnest.stream/.../manifest.json');
      expect(safe).not.toContain('super-secret-bearer-token');

      const safeInvalid = provider.getSafeLogUrl('not-a-url');
      expect(safeInvalid).toBe('[invalid-url]');
    });

    test('never logs a bearer URL embedded in an upstream error message', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn().mockRejectedValue(new Error(`request failed for ${REDACTED_MANIFEST_URL}`));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await provider.refreshIndex();
        await provider.resolveStream('flix:test', 'cricket', 'Match', {});
        const logged = warn.mock.calls.flat().join(' ');
        expect(logged).not.toContain('REDACTED_BEARER_TOKEN');
        expect(logged).not.toContain(REDACTED_MANIFEST_URL);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('Fixtures contract verification', () => {
    test('locks observed taxonomy structure { name, slug, count }', () => {
      for (const list of [MOCK_TAXONOMY_DREAM4K, MOCK_TAXONOMY_DINO, MOCK_TAXONOMY_CLOUD]) {
        for (const item of list) {
          expect(typeof item.name).toBe('string');
          expect(typeof item.slug).toBe('string');
          expect(typeof item.count).toBe('number');
          expect(item.count).toBeGreaterThan(0);
        }
      }
    });

    test('locks observed catalog pagination route with skip extra', () => {
      const provider = new KafkaProvider({});
      const routeNoSkip = provider.buildCatalogUrl('https://flixnest.stream/u/TOKEN/manifest.json', 'flix-cat-cricket');
      expect(routeNoSkip).toBe('https://flixnest.stream/u/TOKEN/catalog/tv/flix-cat-cricket.json');

      const routeWithSkip = provider.buildCatalogUrl('https://flixnest.stream/u/TOKEN/manifest.json', 'flix-cat-cricket', 100);
      expect(routeWithSkip).toBe('https://flixnest.stream/u/TOKEN/catalog/tv/flix-cat-cricket/skip=100.json');
    });
  });

  describe('Sports catalog filtering', () => {
    test('always rejects generic Trex and auto-discovers sports catalogs when allowlist is empty', () => {
      const provider = new KafkaProvider({});
      const allowlist = [
        'flix-live-tv-v2-trex-cat-wc-world-cricket',
        'flix-live-tv-v2-trex-cat-uk-scottish-football'
      ];

      const selected = provider.selectSportsCatalogs(MOCK_MANIFEST, allowlist);
      expect(selected).toHaveLength(2);
      expect(selected.map((c) => c.id)).toEqual([
        'flix-live-tv-v2-trex-cat-wc-world-cricket',
        'flix-live-tv-v2-trex-cat-uk-scottish-football'
      ]);

      // Ensure generic trex catalog is never selected even if someone put it in allowlist
      const selectedWithGeneric = provider.selectSportsCatalogs(MOCK_MANIFEST, [
        'flix-live-tv-v2-trex',
        'flix-live-tv-v2-trex-cat-wc-world-cricket'
      ]);
      expect(selectedWithGeneric.map((c) => c.id)).toEqual([
        'flix-live-tv-v2-trex-cat-wc-world-cricket'
      ]);

      // Empty allowlist discovers sports categories dynamically while excluding
      // both the generic all-TV catalog and non-sports category catalogs.
      expect(provider.selectSportsCatalogs(MOCK_MANIFEST, []).map((c) => c.id)).toEqual([
        'flix-live-tv-v2-trex-cat-wc-world-cricket',
        'flix-live-tv-v2-trex-cat-uk-scottish-football'
      ]);
    });
  });

  describe('Bounded catalog fetching and pagination', () => {
    test('fetches catalog items with bounded parameters and stops when page has fewer items', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn(async (url, opts) => {
        expect(opts.timeoutMs).toBeLessThanOrEqual(15000);
        expect(opts.maxBodyBytes).toBeLessThanOrEqual(2 * 1024 * 1024);

        if (url.endsWith('/manifest.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => MOCK_MANIFEST
          };
        }
        if (url.includes('/catalog/tv/flix-live-tv-v2-trex-cat-wc-world-cricket.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => MOCK_SPORTS_CATALOG_PAGE
          };
        }
        return { ok: false, status: 404 };
      });

      const items = await provider.fetchCatalogMetas('flix-live-tv-v2-trex-cat-wc-world-cricket', { pageSize: 100 });
      expect(items).toHaveLength(2);
      expect(items[0].id).toBe('flix:wc-sky-cricket-hd');
      expect(items[1].id).toBe('flix:wc-willow-usa');
      // Fetched only page 0 because length (2) < pageSize (100)
      expect(provider.proxyFetch).toHaveBeenCalledTimes(1);
    });

    test('handles 401/403 entitlement errors gracefully without throwing or crashing', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Forbidden' })
      }));

      const metas = await provider.fetchCatalogMetas('some-catalog');
      expect(metas).toEqual([]);
      expect(provider.lastErrorStatus).toBe(403);
    });

    test('caps the total number of catalog items retained', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => MOCK_SPORTS_CATALOG_PAGE
      });

      const metas = await provider.fetchCatalogMetas('sports', { pageSize: 100, maxItems: 1 });
      expect(metas).toHaveLength(1);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Task 2: Sports Channel Index and Identity Matching', () => {
    test('refreshIndex builds O(1) index from allowlisted sports catalogs and obeys TTL', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';
      process.env.KAFKA_INDEX_TTL_MS = '60000';

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn(async (url) => {
        if (url.endsWith('/manifest.json')) {
          return { ok: true, status: 200, json: async () => MOCK_MANIFEST };
        }
        if (url.includes('/catalog/tv/flix-live-tv-v2-trex-cat-wc-world-cricket.json')) {
          return { ok: true, status: 200, json: async () => MOCK_SPORTS_CATALOG_PAGE };
        }
        return { ok: false, status: 404 };
      });

      // 1. First refresh builds index
      const index = await provider.refreshIndex();
      expect(index.size).toBe(2);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(2); // manifest + 1 catalog

      // 2. Second refresh within TTL reuses cached index
      const indexCached = await provider.refreshIndex();
      expect(indexCached).toBe(index);
      expect(provider.proxyFetch).toHaveBeenCalledTimes(2); // No new network call
    });

    test('single-flight refresh prevents duplicate concurrent catalog sweeps', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';

      const provider = new KafkaProvider({});
      let resolveManifest;
      provider.proxyFetch = jest.fn((url) => {
        if (url.endsWith('/manifest.json')) {
          return new Promise((resolve) => {
            resolveManifest = () => resolve({ ok: true, status: 200, json: async () => MOCK_MANIFEST });
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => MOCK_SPORTS_CATALOG_PAGE });
      });

      const p1 = provider.refreshIndex();
      const p2 = provider.refreshIndex();
      expect(provider.proxyFetch).toHaveBeenCalledTimes(1);

      resolveManifest();
      const [idx1, idx2] = await Promise.all([p1, p2]);
      expect(idx1).toBe(idx2);
      expect(idx1.size).toBe(2);
    });

    test('retains the last-good snapshot when refresh fails', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => MOCK_MANIFEST })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => MOCK_SPORTS_CATALOG_PAGE });

      const goodIndex = await provider.refreshIndex();
      expect(goodIndex.size).toBe(2);

      // Force TTL expiry
      provider._lastIndexTime = 0;

      // Fail next refresh
      provider.proxyFetch = jest.fn().mockRejectedValue(new Error('Upstream timeout'));
      const retainedIndex = await provider.refreshIndex();
      expect(retainedIndex).toBe(goodIndex);
      expect(retainedIndex.size).toBe(2);
    });

    test('retains the complete last-good index when one catalog fails during refresh', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = [
        'flix-live-tv-v2-trex-cat-wc-world-cricket',
        'flix-live-tv-v2-trex-cat-uk-scottish-football'
      ].join(',');

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn(async (url) => {
        if (url.endsWith('/manifest.json')) return { ok: true, status: 200, json: async () => MOCK_MANIFEST };
        const name = url.includes('world-cricket') ? 'Sky Sports Cricket' : 'TNT Sports 1';
        return { ok: true, status: 200, json: async () => ({ metas: [{ id: `flix:${name}`, name }] }) };
      });
      const goodIndex = await provider.refreshIndex();
      expect(goodIndex.size).toBe(2);

      provider._lastIndexTime = 0;
      provider.proxyFetch = jest.fn(async (url) => {
        if (url.endsWith('/manifest.json')) return { ok: true, status: 200, json: async () => MOCK_MANIFEST };
        if (url.includes('world-cricket')) {
          return { ok: true, status: 200, json: async () => ({ metas: [{ id: 'flix:replacement', name: 'Replacement Sports' }] }) };
        }
        return { ok: false, status: 503 };
      });

      const retainedIndex = await provider.refreshIndex();
      expect(retainedIndex).toBe(goodIndex);
      expect(provider.createSource('Sky Sports Cricket')).not.toBeNull();
      expect(provider.createSource('TNT Sports 1')).not.toBeNull();
      expect(provider.createSource('Replacement Sports')).toBeNull();
    });

    test('createSource resolves exact broadcaster identity in O(1)', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn(async (url) => {
        if (url.endsWith('/manifest.json')) return { ok: true, status: 200, json: async () => MOCK_MANIFEST };
        return { ok: true, status: 200, json: async () => MOCK_SPORTS_CATALOG_PAGE };
      });
      await provider.refreshIndex();

      const source = provider.createSource('Sky Sports Cricket');
      expect(source).toEqual({
        source: 'kafka',
        id: 'flix:wc-sky-cricket-hd',
        channelName: 'Sky Sports Cricket',
        catalogId: 'flix-live-tv-v2-trex-cat-wc-world-cricket',
        country: 'United Kingdom',
        language: 'English',
        type: 'channel'
      });
    });

    test('refuses ambiguous identities, conflicting country context, mismatched channel numbers, backups, and timeshift', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;
      process.env.KAFKA_CATALOG_ALLOWLIST = 'flix-live-tv-v2-trex-cat-wc-world-cricket';

      const provider = new KafkaProvider({});
      const customPage = {
        metas: [
          { id: 'flix:sky-1', name: 'Sky Sports 1' },
          { id: 'flix:sky-2', name: 'Sky Sports 2' },
          { id: 'flix:sky-backup', name: 'Sky Sports 1 (Backup)' },
          { id: 'flix:sky-timeshift', name: 'Sky Sports 1 (+1)' },
          { id: 'flix:dup-us', name: 'SportsNet (US)' },
          { id: 'flix:dup-ca', name: 'SportsNet (CA)' }
        ]
      };
      provider.proxyFetch = jest.fn(async (url) => {
        if (url.endsWith('/manifest.json')) return { ok: true, status: 200, json: async () => MOCK_MANIFEST };
        return { ok: true, status: 200, json: async () => customPage };
      });
      await provider.refreshIndex();

      // Mismatched channel number: asking for Sky Sports without number or with wrong number
      expect(provider.createSource('Sky Sports 3')).toBeNull();

      // Backup rejection: standard request should not match backup feed
      const src1 = provider.createSource('Sky Sports 1');
      expect(src1).not.toBeNull();
      expect(src1.id).toBe('flix:sky-1');

      // Timeshift rejection: standard request should not match timeshift
      expect(provider.createSource('Sky Sports 1 (+1)')).not.toBeNull(); // explicit timeshift matches timeshift

      // Ambiguous without country disambiguation
      expect(provider.createSource('SportsNet')).toBeNull();

      // Disambiguated by country context
      const srcUS = provider.createSource('SportsNet', { country: 'United States' });
      expect(srcUS).not.toBeNull();
      expect(srcUS.id).toBe('flix:dup-us');

      // Conflicting country context rejection
      expect(provider.createSource('Sky Sports 1', { country: 'United States' })).toBeNull();
    });
  });

  describe('Task 4: Resolve Kafka Streams', () => {
    test('resolves direct streams via Stremio route and preserves metadata', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;

      const provider = new KafkaProvider({});
      const controller = new AbortController();
      provider.proxyFetch = jest.fn(async (url, opts) => {
        expect(url).toBe('https://flixnest.stream/u/REDACTED_BEARER_TOKEN/stream/tv/flix%3Awc-sky-cricket-hd.json');
        expect(opts.timeoutMs).toBeLessThanOrEqual(8000);
        expect(opts.signal).toBe(controller.signal);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            streams: [
              {
                name: '1080p',
                title: 'Sky Sports Cricket HD - 1080p',
                url: 'https://cdn.example.invalid/hls/live.m3u8',
                behaviorHints: {
                  proxyHeaders: {
                    request: {
                      'User-Agent': 'CustomUA'
                    }
                  }
                }
              }
            ]
          })
        };
      });

      const src = {
        source: 'kafka',
        id: 'flix:wc-sky-cricket-hd',
        channelName: 'Sky Sports Cricket',
        country: 'United Kingdom',
        language: 'English'
      };

      const streams = await provider.resolveStream('flix:wc-sky-cricket-hd', 'cricket', 'India vs England', src, { signal: controller.signal });
      expect(streams).toHaveLength(1);
      const s = streams[0];
      expect(s.name).toBe('Kafka');
      expect(s.title).toContain('Sky Sports Cricket');
      expect(s.title).toContain('1080p');
      expect(s.url).toBe('https://cdn.example.invalid/hls/live.m3u8');
      expect(s.behaviorHints.proxyHeaders.request['User-Agent']).toBe('CustomUA');
      expect(s.channelName).toBe('Sky Sports Cricket');
    });

    test('drops externalUrl, missing urls, and blocked DASH streams', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          streams: [
            {
              name: 'Web Player',
              externalUrl: 'https://player.example.invalid/watch'
            },
            {
              name: 'No URL Stream'
            },
            {
              name: 'DASH Stream',
              url: 'https://cdn.example.invalid/stream.mpd'
            },
            {
              name: 'ClearKey DASH',
              url: 'https://cdn.example.invalid/manifest.mpd',
              clearkey: { keyId: '123' }
            },
            {
              name: 'Valid HLS Stream',
              url: 'https://cdn.example.invalid/stream.m3u8'
            }
          ]
        })
      }));

      const src = { channelName: 'Sky Sports Cricket' };
      const streams = await provider.resolveStream('flix:test', 'cricket', 'Match', src);
      expect(streams).toHaveLength(1);
      expect(streams[0].url).toBe('https://cdn.example.invalid/stream.m3u8');
    });

    test('returns empty array on 401/403 or network failure without throwing', async () => {
      process.env.KAFKA_ENABLED = 'true';
      process.env.KAFKA_MANIFEST_URL = REDACTED_MANIFEST_URL;

      const provider = new KafkaProvider({});
      provider.proxyFetch = jest.fn().mockRejectedValue(new Error('Network timeout'));

      const streams = await provider.resolveStream('flix:test', 'cricket', 'Match', {});
      expect(streams).toEqual([]);
    });
  });
});
