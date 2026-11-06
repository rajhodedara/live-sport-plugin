'use strict';

const leafMint = require('../src/services/LeafMint');
const LeafProvider = require('../src/providers/LeafProvider');
const { isLeafTarget } = require('../src/services/GuardedEgressPolicy');
const {
  sanitizeManifestBody,
  parseUpstreamManifest,
  isTransientFetchFailure
} = require('../src/routes/leafManifest');

describe('Leaf Followup - Premium URL, Origin & Token Normalization', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LEAF_API_URL;
    delete process.env.LEAF_API_ORIGIN;
    delete process.env.LEAF_INSTALL_CONFIG;
    delete process.env.LEAF_FREE_USER_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('normalizes official Highfly Premium subscription URL', () => {
    const premiumUrl = 'https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json';
    const normalized = leafMint.normalizeConfigBlob(premiumUrl);
    expect(normalized).toBe('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
  });

  test('normalizes regional Highfly subdomains (us2, eu1, dev)', () => {
    const urls = [
      'https://premium-us2.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json',
      'https://premium-eu1.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json',
      'https://sports.highfly.dev/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json',
      'https://highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'
    ];

    for (const url of urls) {
      expect(leafMint.normalizeConfigBlob(url)).toBe('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
    }
  });

  test('preserves bare UUID without wrapping into base64url freeUserId', () => {
    const uuid = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    expect(leafMint.normalizeConfigBlob(uuid)).toBe(uuid);
  });

  test('wraps free-tier dot-separated tokens into base64url freeUserId JSON', () => {
    const freeToken = 'bbecb026-6920-4b62-b006-ddd3eeb31e8d.6bd757136d146439';
    const normalized = leafMint.normalizeConfigBlob(freeToken);
    const decoded = JSON.parse(Buffer.from(normalized, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ freeUserId: freeToken });
  });

  test('normalizes root manifest.json to empty string', () => {
    expect(leafMint.normalizeConfigBlob('https://sports.highfly.to/manifest.json')).toBe('');
    expect(leafMint.normalizeConfigBlob('https://premium.highfly.to/manifest.json')).toBe('');
    expect(leafMint.normalizeConfigBlob('manifest.json')).toBe('');
  });

  test('extractOrigin resolves origin from full URLs, schemeless domains, and bare UUIDs', () => {
    expect(leafMint.extractOrigin('https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json')).toBe('https://premium.highfly.to');
    expect(leafMint.extractOrigin('premium-us2.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')).toBe('https://premium-us2.highfly.to');
    expect(leafMint.extractOrigin('a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')).toBe('https://premium.highfly.to');
    expect(leafMint.extractOrigin('https://sports.highfly.to/')).toBe('https://sports.highfly.to');
    expect(leafMint.extractOrigin('bbecb026-6920-4b62-b006-ddd3eeb31e8d.6bd757136d146439')).toBeNull();
  });

  test('apiBase and LeafProvider.buildApiUrl automatically detect origin from full premium URL', () => {
    process.env.LEAF_INSTALL_CONFIG = 'https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json';
    expect(leafMint.apiBase()).toBe('https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
    expect(LeafProvider.buildApiUrl()).toBe('https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
  });

  test('apiBase automatically resolves bare UUID to premium origin', () => {
    process.env.LEAF_INSTALL_CONFIG = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    expect(leafMint.apiBase()).toBe('https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
    expect(LeafProvider.buildApiUrl()).toBe('https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
  });

  test('explicit LEAF_API_ORIGIN takes precedence over detected origin', () => {
    process.env.LEAF_INSTALL_CONFIG = 'https://sports.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json';
    process.env.LEAF_API_ORIGIN = 'https://premium-dedicated.highfly.to';
    expect(leafMint.apiBase()).toBe('https://premium-dedicated.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d');
  });

  test('LEAF_API_URL acts as complete override kill switch', () => {
    process.env.LEAF_API_URL = 'http://127.0.0.1:9/leaf-disabled/manifest.json';
    process.env.LEAF_INSTALL_CONFIG = 'https://premium.highfly.to/a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d/manifest.json';
    expect(leafMint.apiBase()).toBe('http://127.0.0.1:9/leaf-disabled');
    expect(LeafProvider.buildApiUrl()).toBe('http://127.0.0.1:9/leaf-disabled');
  });
});

describe('Leaf Followup - Guarded Egress Policy', () => {
  test('isLeafTarget recognizes all highfly.to and highfly.dev subdomains', () => {
    expect(isLeafTarget('https://sports.highfly.to/stream')).toBe(true);
    expect(isLeafTarget('https://premium.highfly.to/manifest.json')).toBe(true);
    expect(isLeafTarget('https://premium-eu1.highfly.to/stream')).toBe(true);
    expect(isLeafTarget('https://premium-us2.highfly.to/stream')).toBe(true);
    expect(isLeafTarget('https://api.highfly.dev/catalog')).toBe(true);
    expect(isLeafTarget('https://highfly.to/')).toBe(true);
  });

  test('isLeafTarget recognizes papacito.cfd but excludes video CDN hosts (w1.papacito.cfd and east.papacito.cfd)', () => {
    expect(isLeafTarget('https://papacito.cfd/m3u/test/live.m3u8')).toBe(true);
    expect(isLeafTarget('https://w1.papacito.cfd/leaf/test/seg_1.ts')).toBe(false);
    expect(isLeafTarget('https://east.papacito.cfd/leaf/test/seg_1.ts')).toBe(false);
    expect(isLeafTarget('https://unrelated-domain.com/')).toBe(false);
  });
});

describe('Leaf Followup - Mint Cache TTL and Rate Limit Handling', () => {
  test('MINT_TTL_MS defaults to hours (at least 1 hour)', () => {
    expect(leafMint.MINT_TTL_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  test('isRateLimit detects upstream rate limit notifications', () => {
    const rateLimitStreams = [
      { name: 'Rate limit exceeded', title: 'Too many stream requests. Please wait a moment.' }
    ];
    expect(leafMint.isRateLimit(rateLimitStreams)).toBe(true);
    expect(LeafProvider.isRateLimit(rateLimitStreams)).toBe(true);

    const normalStreams = [
      { name: 'Leaf (Strong)', title: '1920x1080', url: 'https://papacito.cfd/m3u/abc/live.m3u8?token=xyz' }
    ];
    expect(leafMint.isRateLimit(normalStreams)).toBe(false);
    expect(LeafProvider.isRateLimit(normalStreams)).toBe(false);
  });

  test('mintUrl preserves existing cached Papacito URL when upstream rate limits', async () => {
    process.env.LEAF_INSTALL_CONFIG = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    const matchId = 'streamed:test-rate-limit-match';
    const slug = 'test-slug-429';
    const cachedUrl = `https://papacito.cfd/m3u/${slug}/live.m3u8?token=initial-token-123`;

    // Seed the cache
    leafMint.seed(matchId, slug, cachedUrl);

    // Now call mintUrl - since it is cached and TTL is hours, it returns the cached URL
    const result = await leafMint.mintUrl(matchId, slug);
    expect(result).toBe(cachedUrl);
  });

  test('mintUrl with force=true preserves cached URL if upstream responds with rate limit stub', async () => {
    process.env.LEAF_INSTALL_CONFIG = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
    const matchId = 'streamed:test-force-rate-limit';
    const slug = 'test-slug-forced';
    const cachedUrl = `https://papacito.cfd/m3u/${slug}/live.m3u8?token=active-token`;

    leafMint.seed(matchId, slug, cachedUrl);

    const providerOutbound = require('../src/services/ProviderOutbound');
    const spy = jest.spyOn(providerOutbound, 'safeFetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        streams: [
          { name: 'Rate limit exceeded', title: 'Too many stream requests. Please wait a moment.' }
        ]
      })
    });

    const result = await leafMint.mintUrl(matchId, slug, { force: true });
    expect(result).toBe(cachedUrl);
    spy.mockRestore();

    // Verify that subsequent normal mintUrl call does NOT throw ERR_LEAF_MINT_COOLDOWN
    // despite the active cooldown in fails map!
    expect(leafMint.isCoolingDown(matchId, slug)).toBe(true);
    const subsequentResult = await leafMint.mintUrl(matchId, slug);
    expect(subsequentResult).toBe(cachedUrl);
  });
});

describe('Leaf Followup - Multi-CDN Support (Cloudflare & Bunny CDN)', () => {
  test('sanitizeManifestBody retains Bunny CDN absolute segment URLs', () => {
    const rawM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:6.000,
https://east.papacito.cfd/leaf/test-slug/12345/seg_100.ts?a=hash1&u=user1
#EXTINF:6.000,
https://east.papacito.cfd/leaf/test-slug/12345/seg_101.ts?a=hash2&u=user1`;

    const sanitized = sanitizeManifestBody(rawM3u8, 'https://papacito.cfd/m3u/test-slug/live.m3u8?token=xyz');
    expect(sanitized).toContain('https://east.papacito.cfd/leaf/test-slug/12345/seg_100.ts?a=hash1&u=user1');
    expect(sanitized).toContain('https://east.papacito.cfd/leaf/test-slug/12345/seg_101.ts?a=hash2&u=user1');
  });

  test('sanitizeManifestBody retains Cloudflare CDN absolute segment URLs', () => {
    const rawM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:200
#EXTINF:6.000,
https://w1.papacito.cfd/leaf/test-slug/67890/seg_200.ts?a=hash3
#EXTINF:6.000,
https://w1.papacito.cfd/leaf/test-slug/67890/seg_201.ts?a=hash4`;

    const sanitized = sanitizeManifestBody(rawM3u8, 'https://papacito.cfd/m3u/test-slug/live.m3u8?token=xyz');
    expect(sanitized).toContain('https://w1.papacito.cfd/leaf/test-slug/67890/seg_200.ts?a=hash3');
    expect(sanitized).toContain('https://w1.papacito.cfd/leaf/test-slug/67890/seg_201.ts?a=hash4');
  });

  test('parseUpstreamManifest extracts cdnBase from both Bunny CDN and Cloudflare CDN segments', () => {
    const bunnyM3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:688
#EXTINF:6.000,
https://east.papacito.cfd/leaf/boxing-match/999/seg_689.ts?a=hash`;

    const bunnyParsed = parseUpstreamManifest(bunnyM3u8, 'https://papacito.cfd/m3u/boxing-match/live.m3u8');
    expect(bunnyParsed.cdnBase).toBe('https://east.papacito.cfd');
    expect(bunnyParsed.slug).toBe('boxing-match');
    expect(bunnyParsed.session).toBe('999');
    expect(bunnyParsed.edge).toBe(689);

    const cfM3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:50
#EXTINF:6.000,
https://w1.papacito.cfd/leaf/football-match/888/seg_51.ts?a=hash`;

    const cfParsed = parseUpstreamManifest(cfM3u8, 'https://papacito.cfd/m3u/football-match/live.m3u8');
    expect(cfParsed.cdnBase).toBe('https://w1.papacito.cfd');
    expect(cfParsed.slug).toBe('football-match');
    expect(cfParsed.session).toBe('888');
    expect(cfParsed.edge).toBe(51);
  });

  test('isTransientFetchFailure classifies rate limits and mint cooldowns as transient', () => {
    expect(isTransientFetchFailure({ code: 'ERR_LEAF_MINT_RATE_LIMIT' })).toBe(true);
    expect(isTransientFetchFailure({ code: 'ERR_LEAF_MINT_COOLDOWN' })).toBe(true);
    expect(isTransientFetchFailure({ cooldown: true })).toBe(true);
    expect(isTransientFetchFailure({ rateLimit: true })).toBe(true);
    expect(isTransientFetchFailure({ upstreamStatus: 429 })).toBe(true);
    expect(isTransientFetchFailure({ code: 'ERR_LEAF_UPSTREAM_DENIED' })).toBe(false);
  });
});
