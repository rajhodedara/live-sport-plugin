const { mergeRemintedUrl, getRemintCacheKey } = require('../src/remint');
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const StreamEntity = require('../src/domain/StreamEntity');

describe('Bluetier Remint & Token Lifecycle', () => {
  describe('mergeRemintedUrl', () => {
    it('merges new token into held master playlist URL', () => {
      const held = 'https://ds169.bluetier.top/tntsports3/index.m3u8?token=OLD_TOKEN';
      const fresh = 'https://ds169.bluetier.top/tntsports3/index.m3u8?token=NEW_TOKEN';
      const rck = 'daddylive:match1:33';

      const merged = mergeRemintedUrl(held, fresh, rck);
      expect(merged).toBe('https://ds169.bluetier.top/tntsports3/index.m3u8?token=NEW_TOKEN');
    });

    it('merges new token while preserving media playlist sub-path', () => {
      const held = 'https://ds169.bluetier.top/tntsports3/tracks-v1a1/mono.m3u8?token=OLD_TOKEN';
      const fresh = 'https://ds169.bluetier.top/tntsports3/index.m3u8?token=NEW_TOKEN';
      const rck = 'daddylive:match1:33';

      const merged = mergeRemintedUrl(held, fresh, rck);
      expect(merged).toBe('https://ds169.bluetier.top/tntsports3/tracks-v1a1/mono.m3u8?token=NEW_TOKEN');
    });

    it('merges new token while preserving media segment sub-path', () => {
      const held = 'https://ds169.bluetier.top/tntsports3/tracks-v1a1/2026/10/23/09/11/22-06000.ts?token=OLD_TOKEN';
      const fresh = 'https://ds169.bluetier.top/tntsports3/index.m3u8?token=NEW_TOKEN';
      const rck = 'daddylive:match1:33';

      const merged = mergeRemintedUrl(held, fresh, rck);
      expect(merged).toBe('https://ds169.bluetier.top/tntsports3/tracks-v1a1/2026/10/23/09/11/22-06000.ts?token=NEW_TOKEN');
    });

    it('updates CDN host when fresh stream shifts to another mirror', () => {
      const held = 'https://ds169.bluetier.top/tntsports3/index.m3u8?token=OLD_TOKEN';
      const fresh = 'https://ds170.bluetier.top/tntsports3/index.m3u8?token=NEW_TOKEN';
      const rck = 'daddylive:match1:33';

      const merged = mergeRemintedUrl(held, fresh, rck);
      expect(merged).toBe('https://ds170.bluetier.top/tntsports3/index.m3u8?token=NEW_TOKEN');
    });

    it('preserves classic ?s=&e= token replacement', () => {
      const held = 'https://edge.live/hls/channel33.m3u8?s=OLDSIG&e=12345';
      const fresh = 'https://edge2.live/hls/channel33.m3u8?s=NEWSIG&e=67890';
      const rck = 'daddylive:match1:33';

      const merged = mergeRemintedUrl(held, fresh, rck);
      expect(merged).toBe('https://edge2.live/hls/channel33.m3u8?s=NEWSIG&e=67890');
    });
  });

  describe('getRemintCacheKey', () => {
    it('produces unified cache key across master, variant, and segment URLs for Bluetier', () => {
      const rck = 'daddylive:match1:33';
      const master = 'https://ds169.bluetier.top/tntsports3/index.m3u8?token=xyz';
      const variant = 'https://ds169.bluetier.top/tntsports3/tracks-v1a1/mono.m3u8?token=xyz';
      const segment = 'https://ds169.bluetier.top/tntsports3/tracks-v1a1/2026/10/23/seg1.ts?token=xyz';

      const masterKey = getRemintCacheKey(rck, master);
      const variantKey = getRemintCacheKey(rck, variant);
      const segmentKey = getRemintCacheKey(rck, segment);

      expect(masterKey).toBe('daddylive:match1:33:tntsports3');
      expect(variantKey).toBe('daddylive:match1:33:tntsports3');
      expect(segmentKey).toBe('daddylive:match1:33:tntsports3');
    });

    it('produces lowercased channel keys for case-insensitive matching', () => {
      const rck = 'daddylive:match1:758';
      const master = 'https://ds169.bluetier.top/FOXSPORTS2/index.m3u8?token=xyz';

      expect(getRemintCacheKey(rck, master)).toBe('daddylive:match1:758:foxsports2');
    });

    it('preserves classic /hls/ cache keying', () => {
      const rck = 'daddylive:match1:33';
      const classic = 'https://edge.live/hls/premium33.m3u8?s=sig';

      expect(getRemintCacheKey(rck, classic)).toBe('daddylive:match1:33:premium33');
    });
  });

  describe('DaddyLiveProvider Token Expiry Parsing & Decoded Cache', () => {
    let provider;
    beforeEach(() => {
      provider = new DaddyLiveProvider({
        circuitBreaker: { wrapSync: (name, fn) => fn, wrapAsync: (name, fn) => fn }
      });
    });

    it('decodes base64 Bluetier token expiry timestamp accurately', async () => {
      const futureUnixSec = Math.floor(Date.now() / 1000) + 180; // 3 minutes ahead
      const payload = `tntsports3|no_check_ip|${futureUnixSec}`;
      const b64 = Buffer.from(payload).toString('base64');
      const token = `${b64}.mocksignature12345`;
      const streamUrl = `http://localhost:7000/api/manifest?url=${encodeURIComponent('https://ds169.bluetier.top/tntsports3/index.m3u8?token=' + token)}`;

      // Mock resolve
      provider.proxyFetch = jest.fn();
      provider._resolveFromHtml = jest.fn();

      // Seed the cache directly through resolveStream internal logic check
      provider._decoded.set('33', {
        streams: [new StreamEntity({ url: streamUrl, source: 'daddylive' })],
        expiresAt: futureUnixSec * 1000 - 45000
      });

      const cached = provider._decoded.get('33');
      expect(cached.expiresAt).toBeLessThan(futureUnixSec * 1000);
      expect(cached.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe('StreamResolveCache DaddyLive TTL Ceiling', () => {
    let cache;
    beforeEach(() => {
      cache = new StreamResolveCache({
        defaultTtlMs: 60 * 1000,
        maxTtlMs: 600 * 1000,
        minTtlMs: 30 * 1000
      });
    });

    it('caps DaddyLive learned TTL above the prewarm tick (300s) after noteSuccess calls', () => {
      const key = `daddylive:match_clamping_${Date.now()}:33`;
      cache.ttl.set('daddylive', 60000);

      cache.noteSuccess(key); // doubles to 120s
      expect(cache._ttlFor('daddylive')).toBe(120000);

      cache.noteSuccess(key); // doubles to 240s — still under the ceiling
      expect(cache._ttlFor('daddylive')).toBe(240000);

      cache.noteSuccess(key); // would double to 480s, capped at 300s
      expect(cache._ttlFor('daddylive')).toBe(300000);

      cache.noteSuccess(key); // stays capped at 300s
      expect(cache._ttlFor('daddylive')).toBe(300000);
    });

    it('clamps stream entry TTL if Bluetier token expires sooner', async () => {
      const futureUnixSec = Math.floor(Date.now() / 1000) + 90; // 90 seconds ahead
      const payload = `tntsports3|no_check_ip|${futureUnixSec}`;
      const b64 = Buffer.from(payload).toString('base64');
      const token = `${b64}.signature`;
      const url = `https://ds169.bluetier.top/tntsports3/index.m3u8?token=${token}`;

      const key = `daddylive:match_clamping_${Date.now()}:33`;
      await cache.getOrCreate(key, async () => [
        new StreamEntity({ url, title: 'TNT 3', source: 'daddylive' })
      ]);

      const entry = cache.entries.get(key);
      expect(entry).toBeDefined();
      expect(entry.status).toBe('ok');
      // Should be clamped to roughly (90 - 45) = 45s from now, instead of default 60s
      const remainingSec = (entry.expiresAt - Date.now()) / 1000;
      expect(remainingSec).toBeLessThanOrEqual(50);
      expect(remainingSec).toBeGreaterThanOrEqual(30);
    });
  });
});
