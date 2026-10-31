'use strict';

jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(async () => { throw new Error('Unexpected WASM execution in unit fixture'); }),
  destroy: jest.fn(async () => {})
}));
jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(async () => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  request: jest.fn(async () => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  fetch: jest.fn(async () => { throw new Error('Unexpected provider I/O in unit fixture'); }),
  streamingFetch: jest.fn(async () => { throw new Error('Unexpected provider I/O in unit fixture'); })
}));

const ChannelIdentityService = require('../src/services/ChannelIdentityService');
const { compareStreams } = require('../src/services/LanguagePriorityService');
const MatchAggregator = require('../src/services/MatchAggregator');
const CacheService = require('../src/services/CacheService');
const MatchEntity = require('../src/domain/MatchEntity');
const StreamEntity = require('../src/domain/StreamEntity');
const { formatChannelStreamTitle, deduplicateResolutions } = require('../src/streams');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Universal 24/7 Channel Identity & Aggregation Architecture', () => {

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 1: Universal Channel Identity Parsing
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 1: ChannelIdentityService Parsing & Normalization', () => {
    test('strips country and regional suffixes while extracting country metadata', () => {
      const res = ChannelIdentityService.parseChannel('Astro Cricket (Malaysia)', { group: 'Malaysia' });
      expect(res.canonicalTitle).toBe('Astro Cricket');
      expect(res.country).toBe('Malaysia');
      expect(res.countryCode).toBe('MY');
      expect(res.countryFlag).toBe('🇲🇾');
      expect(res.identityKey).toBe('astrocricket');
    });

    test('strips language markers and sets language metadata', () => {
      const res = ChannelIdentityService.parseChannel('Cartoon Network Arabic (EN)', { language: 'Arabic' });
      expect(res.canonicalTitle).toBe('Cartoon Network');
      expect(res.language).toBe('Arabic');
      expect(res.identityKey).toBe('cartoonnetwork');
    });

    test('strips resolution, framerate, and codec markers', () => {
      const res = ChannelIdentityService.parseChannel('Sky Sports Main Event UHD 4K 50FPS HEVC H.265');
      expect(res.canonicalTitle).toBe('Sky Sports Main Event');
      expect(res.resolution).toBe('4K');
      expect(res.identityKey).toBe('skysportmainevent');
    });

    test('identifies backup feeds and strips backup markers', () => {
      const res = ChannelIdentityService.parseChannel('TNT Sports 1 Backup HD');
      expect(res.canonicalTitle).toBe('TNT Sports 1');
      expect(res.isBackup).toBe(true);
      expect(res.resolution).toBe('HD');
      expect(res.identityKey).toBe('tntsport1');
    });

    test('normalizes sports singular/plural mismatch so TNT SPORT 1 and TNT SPORTS 1 yield exact same key', () => {
      const singular = ChannelIdentityService.parseChannel('TNT SPORT 1');
      const plural = ChannelIdentityService.parseChannel('TNT SPORTS 1');
      const pluralHD = ChannelIdentityService.parseChannel('TNT SPORTS 1 HD');

      expect(singular.canonicalTitle).toBe('TNT Sports 1');
      expect(plural.canonicalTitle).toBe('TNT Sports 1');
      expect(pluralHD.canonicalTitle).toBe('TNT Sports 1');

      expect(singular.identityKey).toBe('tntsport1');
      expect(plural.identityKey).toBe('tntsport1');
      expect(pluralHD.identityKey).toBe('tntsport1');

      expect(singular.channelNumber).toBe('1');
      expect(plural.channelNumber).toBe('1');
    });

    test('preserves single-letter brand acronyms like F1, M6, TF1 without splitting or false channel numbers', () => {
      const f1 = ChannelIdentityService.parseChannel('Sky Sports F1');
      expect(f1.canonicalTitle).toBe('Sky Sports F1');
      expect(f1.channelNumber).toBeNull();
      expect(f1.identityKey).toBe('skysportf1');

      const tf1 = ChannelIdentityService.parseChannel('TF1 HD');
      expect(tf1.canonicalTitle).toBe('TF1');
      expect(tf1.channelNumber).toBeNull();

      const m6 = ChannelIdentityService.parseChannel('M6 France');
      expect(m6.canonicalTitle).toBe('M6');
      expect(m6.channelNumber).toBeNull();
    });

    test('glues detached brand digits so "TF 1" and "TF1" resolve to one channel', () => {
      const spaced = ChannelIdentityService.parseChannel('TF 1');
      expect(spaced.canonicalTitle).toBe('TF1');
      expect(spaced.identityKey).toBe('tf1');
      expect(spaced.channelNumber).toBeNull();

      const spacedHd = ChannelIdentityService.parseChannel('TF 1 HD');
      expect(spacedHd.canonicalTitle).toBe('TF1');
      expect(spacedHd.channelNumber).toBeNull();

      const glued = ChannelIdentityService.parseChannel('TF1 France');
      expect(glued.canonicalTitle).toBe('TF1');
      expect(glued.channelNumber).toBeNull();

      // Digits that are part of a real channel number must keep their identity.
      expect(ChannelIdentityService.parseChannel('TV 1000').channelNumber).toBe('1000');
      expect(ChannelIdentityService.parseChannel('Sky Sports F1').channelNumber).toBeNull();
      expect(ChannelIdentityService.parseChannel('beIN Sports 1').channelNumber).toBe('1');
      expect(ChannelIdentityService.parseChannel('Astro Cricket 1').channelNumber).toBe('1');
    });

    test('merges the spaced and glued TF1 cards into one', () => {
      const agg = new MatchAggregator({});
      const build = (id, rawName, source) => {
        const ident = ChannelIdentityService.parseChannel(rawName, { group: 'France' });
        const entity = new MatchEntity({
          id,
          title: ident.canonicalTitle,
          category: 'networks',
          date: '0',
          league: 'France',
          sources: [{ source, channelName: rawName }]
        });
        entity.channelIdentityKey = ident.identityKey;
        entity.channelNumber = ident.channelNumber;
        entity.canonicalTitle = ident.canonicalTitle;
        return entity;
      };

      const daddy = build('dlv_ch_469_tf1', 'TF1 France', 'daddylive');
      const vavoo = build('vavoo_ch_tf-1-france', 'TF 1', 'vavoo');

      expect(daddy.channelNumber).toBeNull();
      expect(vavoo.channelNumber).toBeNull();
      expect(agg.isSameEvent(daddy, vavoo)).toBe(true);
    });

    test('splits glued digits for multi-letter channel names and extracts channel number', () => {
      const bundesliga = ChannelIdentityService.parseChannel('Sky Bundesliga1');
      expect(bundesliga.canonicalTitle).toBe('Sky Bundesliga 1');
      expect(bundesliga.channelNumber).toBe('1');
      expect(bundesliga.identityKey).toBe('skybundesliga1');

      const tnt1 = ChannelIdentityService.parseChannel('TNT1');
      expect(tnt1.canonicalTitle).toBe('TNT 1');
      expect(tnt1.channelNumber).toBe('1');
      expect(tnt1.identityKey).toBe('tnt1');
    });

    test('strips flag emojis, feed modifiers, and regional country codes', () => {
      const emojiCh = ChannelIdentityService.parseChannel('TNT Sports 1 🇬🇧 [RAW]');
      expect(emojiCh.canonicalTitle).toBe('TNT Sports 1');

      const localCh = ChannelIdentityService.parseChannel('Sky Sports Main Event (LOCAL)');
      expect(localCh.canonicalTitle).toBe('Sky Sports Main Event');

      const matchTimeCh = ChannelIdentityService.parseChannel('TNT Sports 2 (MATCH TIME) FEED');
      expect(matchTimeCh.canonicalTitle).toBe('TNT Sports 2');
      expect(matchTimeCh.channelNumber).toBe('2');

      const deCh = ChannelIdentityService.parseChannel('Sky Sport 1 DE');
      expect(deCh.canonicalTitle).toBe('Sky Sports 1');

      const nzCh = ChannelIdentityService.parseChannel('Sky Sport 1 NZ');
      expect(nzCh.canonicalTitle).toBe('Sky Sports 1');
    });

    test('identifies timeshift delay feeds (+1, +2) and strips timeshift tag', () => {
      const res = ChannelIdentityService.parseChannel('Channel 4 +1 HD');
      expect(res.canonicalTitle).toBe('Channel 4');
      expect(res.isTimeshift).toBe(true);
      expect(res.channelNumber).toBe('4');
      expect(res.identityKey).toBe('channel4');
    });

    test('strictly preserves channel numbers for distinct channels', () => {
      const ch1 = ChannelIdentityService.parseChannel('Astro Cricket 1 HD');
      const ch2 = ChannelIdentityService.parseChannel('Astro Cricket 2 HD');

      expect(ch1.canonicalTitle).toBe('Astro Cricket 1');
      expect(ch2.canonicalTitle).toBe('Astro Cricket 2');
      expect(ch1.channelNumber).toBe('1');
      expect(ch2.channelNumber).toBe('2');
      expect(ch1.identityKey).not.toBe(ch2.identityKey);
      expect(ch1.identityKey).toBe('astrocricket1');
      expect(ch2.identityKey).toBe('astrocricket2');
    });

    test('accurately preserves country metadata for regional Vavoo feeds under unified brand', () => {
      const itRes = ChannelIdentityService.parseChannel('SKY SPORT TENNIS', { group: 'Italy', language: 'it' });
      expect(itRes.canonicalTitle).toBe('Sky Sports Tennis');
      expect(itRes.country).toBe('Italy');
      expect(itRes.countryCode).toBe('IT');
      expect(itRes.countryFlag).toBe('🇮🇹');
      expect(itRes.language).toBe('Italian');

      const ukRes = ChannelIdentityService.parseChannel('SKY SPORTS TENNIS', { group: 'United Kingdom', language: 'en' });
      expect(ukRes.canonicalTitle).toBe('Sky Sports Tennis');
      expect(ukRes.country).toBe('United Kingdom');
      expect(ukRes.countryCode).toBe('UK');
      expect(ukRes.countryFlag).toBe('🇬🇧');
      expect(ukRes.language).toBe('English');

      const deRes = ChannelIdentityService.parseChannel('SKY SPORT TENNIS', { group: 'Germany', language: 'de' });
      expect(deRes.canonicalTitle).toBe('Sky Sports Tennis');
      expect(deRes.country).toBe('Germany');
      expect(deRes.countryCode).toBe('DE');
      expect(deRes.countryFlag).toBe('🇩🇪');
      expect(deRes.language).toBe('German');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 2: Cross-Provider Aggregation into Single Meta Card
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 2: Universal Aggregation Across Providers', () => {
    let aggregator;

    beforeEach(() => {
      aggregator = new MatchAggregator();
    });

    test('aggregates matching 24/7 channels across Vavoo, DaddyLive, SKTech, and CDNLive into ONE card', () => {
      const vavoo = new MatchEntity({
        id: 'vavoo_ch_astro_cricket',
        title: 'Astro Cricket (Malaysia)',
        category: 'networks',
        date: '0',
        league: 'Malaysia',
        sources: [{ source: 'vavoo', id: 'https://vavoo.to/astro', group: 'Malaysia', type: 'channel' }]
      });

      const daddylive = new MatchEntity({
        id: 'dlv_ch_123_astro-cricket',
        title: 'Astro Cricket HD',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'daddylive', id: '123', type: 'channel' }]
      });

      const sktech = new MatchEntity({
        id: 'sktech_ch_astro_cricket',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        league: 'Sports',
        sources: [{ source: 'sktech', id: 'sk_astro', type: 'channel' }]
      });

      const cdnlive = new MatchEntity({
        id: 'cdn_ch_my_astro_cricket',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'cdnlive', id: 'cdn_astro', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(vavoo, daddylive)).toBe(true);
      expect(aggregator.isSameEvent(daddylive, sktech)).toBe(true);
      expect(aggregator.isSameEvent(sktech, cdnlive)).toBe(true);

      const merged = aggregator.mergeMatches(vavoo, daddylive);
      expect(merged.title).toBe('Astro Cricket');
      expect(merged.sources.length).toBe(2);

      const mergedAll = aggregator.mergeMatches(merged, sktech);
      const mergedFinal = aggregator.mergeMatches(mergedAll, cdnlive);
      expect(mergedFinal.title).toBe('Astro Cricket');
      expect(mergedFinal.sources.length).toBe(4);
    });

    test('aggregates CARTOONITO across multiple regional feeds into one card', () => {
      const chUK = new MatchEntity({
        id: 'vavoo_ch_cartoonito_uk',
        title: 'Cartoonito UK HD',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', group: 'United Kingdom', type: 'channel' }]
      });

      const chIT = new MatchEntity({
        id: 'vavoo_ch_cartoonito_it',
        title: 'CARTOONITO (Italy)',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', group: 'Italy', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(chUK, chIT)).toBe(true);
      const merged = aggregator.mergeMatches(chUK, chIT);
      expect(merged.title).toBe('Cartoonito');
      expect(merged.sources.length).toBe(2);
    });

    test('merges TNT SPORT 1 (Vavoo) with TNT Sports 1 (DaddyLive/CDNLive) into ONE canonical card', () => {
      const vavooTnt = new MatchEntity({
        id: 'vavoo_ch_tnt1',
        title: 'TNT SPORT 1',
        category: 'networks',
        date: '0',
        league: 'United Kingdom',
        sources: [{ source: 'vavoo', id: 'https://vavoo.to/tnt1', type: 'channel' }]
      });

      const daddyliveTnt = new MatchEntity({
        id: 'dlv_ch_123_tnt-sports-1',
        title: 'TNT Sports 1 HD',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'daddylive', id: '123', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(vavooTnt, daddyliveTnt)).toBe(true);

      const merged = aggregator.mergeMatches(vavooTnt, daddyliveTnt);
      expect(merged.title).toBe('TNT Sports 1');
      expect(merged.sources.length).toBe(2);
    });

    test('updates existing title, baseTitle, and canonicalTitle when merged in syncMatches', async () => {
      const existing = [
        new MatchEntity({
          id: 'vavoo_ch_tnt1',
          title: 'TNT SPORT 1',
          baseTitle: 'TNT SPORT 1',
          category: 'networks',
          date: '0',
          league: 'United Kingdom',
          sources: [{ source: 'vavoo', id: 'v1', type: 'channel' }]
        })
      ];

      const incoming = [
        new MatchEntity({
          id: 'dlv_ch_123',
          title: 'TNT Sports 1',
          baseTitle: 'TNT Sports 1',
          canonicalTitle: 'TNT Sports 1',
          category: 'networks',
          date: '0',
          league: 'Live TV',
          sources: [{ source: 'daddylive', id: 'd1', type: 'channel' }]
        })
      ];

      let saved = [];
      const mockCacheService = { getMatches: () => [], setMatches: (m) => { saved = m; } };
      const agg = new MatchAggregator({ cacheService: mockCacheService });
      agg.providers = [
        { sourceName: 'vavoo', getMatches: async () => existing },
        { sourceName: 'daddylive', getMatches: async () => incoming }
      ];

      const syncResult = await agg.syncMatches();
      expect(syncResult.length).toBe(1);
      expect(syncResult[0].title).toBe('TNT Sports 1');
      expect(syncResult[0].baseTitle).toBe('TNT Sports 1');
      expect(syncResult[0].canonicalTitle).toBe('TNT Sports 1');
      expect(syncResult[0].sources.length).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 3: Stream Ordering within Card (English > Language > Live > Quality > Backup)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 3: Stream Ordering & Prioritization', () => {
    test('ranks English streams before other languages', () => {
      const enStream = new StreamEntity({
        name: 'Stream 1',
        title: 'Vavoo | Cartoon Network — UK — English — 1080p',
        language: 'English',
        quality: '1080p'
      });
      const esStream = new StreamEntity({
        name: 'Stream 2',
        title: 'Vavoo | Cartoon Network — Spain — Spanish — 1080p',
        language: 'Spanish',
        quality: '1080p'
      });

      expect(compareStreams(enStream, esStream)).toBeLessThan(0);
      expect(compareStreams(esStream, enStream)).toBeGreaterThan(0);
    });

    test('ranks higher resolution over lower resolution within same language', () => {
      const stream4k = new StreamEntity({
        name: 'Stream 4K',
        title: 'Vavoo | Astro Cricket — 4K',
        language: 'English',
        quality: '4K',
        resolution: '4K'
      });
      const stream1080 = new StreamEntity({
        name: 'Stream 1080p',
        title: 'Vavoo | Astro Cricket — 1080p',
        language: 'English',
        quality: '1080p',
        resolution: '1080p'
      });
      const stream720 = new StreamEntity({
        name: 'Stream 720p',
        title: 'Vavoo | Astro Cricket — 720p',
        language: 'English',
        quality: '720p',
        resolution: '720p'
      });

      expect(compareStreams(stream4k, stream1080)).toBeLessThan(0);
      expect(compareStreams(stream1080, stream720)).toBeLessThan(0);
    });

    test('ranks standard streams before backup streams', () => {
      const standardStream = new StreamEntity({
        name: 'Standard Stream',
        title: 'DaddyLive | Sky Sports Main Event — English — 1080p',
        language: 'English',
        quality: '1080p',
        isBackup: false
      });
      const backupStream = new StreamEntity({
        name: 'Backup Stream',
        title: 'DaddyLive | Sky Sports Main Event — English — 1080p [Backup]',
        language: 'English',
        quality: '1080p',
        isBackup: true
      });

      expect(compareStreams(standardStream, backupStream)).toBeLessThan(0);
    });

    test('ranks current live streams before timeshift delay streams', () => {
      const currentStream = new StreamEntity({
        name: 'Current Stream',
        title: 'Vavoo | Channel 4 — English — 1080p',
        language: 'English',
        quality: '1080p',
        isTimeshift: false
      });
      const timeshiftStream = new StreamEntity({
        name: 'Timeshift Stream',
        title: 'Vavoo | Channel 4 — English — 1080p [+1 Delay]',
        language: 'English',
        quality: '1080p',
        isTimeshift: true
      });

      expect(compareStreams(currentStream, timeshiftStream)).toBeLessThan(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 4: Explicit Stream Label Formatting
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 4: Explicit Stream Label Formatting', () => {
    test('formats explicit label for 24/7 channel stream: Provider | Channel — Country — Language — Quality', () => {
      const stream = new StreamEntity({
        name: 'vavoo',
        sourceName: 'vavoo',
        title: 'Astro Cricket',
        channelName: 'Astro Cricket (Malaysia)',
        canonicalChannel: 'Astro Cricket',
        country: 'Malaysia',
        countryFlag: '🇲🇾',
        language: 'English',
        resolution: '1080p'
      });

      const label = formatChannelStreamTitle(stream);
      expect(label).toContain('Vavoo | Astro Cricket');
      expect(label).toContain('Malaysia');
      expect(label).toContain('🇲🇾');
      expect(label).toContain('English');
      expect(label).toContain('1080p');
    });

    test('appends [Backup] and [+1 Delay] tags to stream label', () => {
      const stream = new StreamEntity({
        name: 'daddylive',
        sourceName: 'daddylive',
        title: 'Channel 4',
        channelName: 'Channel 4 +1 Backup',
        canonicalChannel: 'Channel 4',
        country: 'United Kingdom',
        countryFlag: '🇬🇧',
        language: 'English',
        resolution: '1080p',
        isBackup: true,
        isTimeshift: true
      });

      const label = formatChannelStreamTitle(stream);
      expect(label).toContain('DaddyLive | Channel 4');
      expect(label).toContain('[Backup]');
      expect(label).toContain('[+1 Delay]');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 5: Strict Merge Protection (False-Merge Guards)
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 5: Strict Merge Protection & False-Merge Guards', () => {
    let aggregator;

    beforeEach(() => {
      aggregator = new MatchAggregator();
    });

    test('NEVER merges channels with different numbers (e.g. Astro Cricket 1 vs Astro Cricket 2)', () => {
      const astro1 = new MatchEntity({
        id: 'vavoo_astro1',
        title: 'Astro Cricket 1 HD',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', type: 'channel' }]
      });

      const astro2 = new MatchEntity({
        id: 'vavoo_astro2',
        title: 'Astro Cricket 2 HD',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(astro1, astro2)).toBe(false);
    });

    test('NEVER merges channels with different network identities (e.g. Cartoon Network vs Cartoonito)', () => {
      const cn = new MatchEntity({
        id: 'dlv_cn',
        title: 'Cartoon Network',
        category: 'networks',
        date: '0',
        sources: [{ source: 'daddylive', type: 'channel' }]
      });

      const cartoonito = new MatchEntity({
        id: 'dlv_cartoonito',
        title: 'Cartoonito',
        category: 'networks',
        date: '0',
        sources: [{ source: 'daddylive', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(cn, cartoonito)).toBe(false);
    });

    test('NEVER merges a 24/7 channel with a live fixture of the same name', () => {
      const liveFixture = new MatchEntity({
        id: 'cdn_fixture_123',
        title: 'Astro Cricket',
        category: 'cricket',
        date: String(Date.now() + 3600000),
        status: 'upcoming',
        sources: [{ source: 'cdnlive' }]
      });

      const channel = new MatchEntity({
        id: 'vavoo_channel_astro',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        sources: [{ source: 'vavoo', type: 'channel' }]
      });

      expect(aggregator.isSameEvent(liveFixture, channel)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 6: Cache Versioning & Migration
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 6: Cache Schema Versioning & Migration', () => {
    let tmpDir, cacheService;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-cache-version-'));
      cacheService = new CacheService();
      cacheService.cacheFilePath = path.join(tmpDir, 'matches_cache.json');
      cacheService.clear();
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    });

    test('writes schemaVersion = 4 to disk when saving matches', () => {
      const match = new MatchEntity({
        id: 'net_astro_cricket',
        title: 'Astro Cricket',
        category: 'networks',
        date: '0',
        sources: []
      });

      cacheService.setMatches([match]);
      expect(fs.existsSync(cacheService.cacheFilePath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(cacheService.cacheFilePath, 'utf-8'));
      expect(content.schemaVersion).toBe(CacheService.CACHE_SCHEMA_VERSION);
      expect(content.schemaVersion).toBe(4);
      expect(content.matches.length).toBe(1);
    });

    test('discards and purges legacy disk cache with schemaVersion < 4', () => {
      // Simulate legacy disk cache saved before universal channel layer
      const legacyPayload = {
        schemaVersion: 3,
        timestamp: Date.now(),
        matches: [{ id: 'legacy_split_card', title: 'Cartoon Network (France)', category: 'networks' }]
      };
      fs.writeFileSync(cacheService.cacheFilePath, JSON.stringify(legacyPayload), 'utf-8');

      // Create a fresh CacheService instance targeting that file
      const newCache = new CacheService(cacheService.cacheFilePath);

      // Legacy entries must be purged, not loaded
      expect(newCache.getMatchesReadOnly()).toEqual([]);
      expect(fs.existsSync(cacheService.cacheFilePath)).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 7: Catalog Multi-Token Search Query
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 7: Catalog Multi-Token Search Query', () => {
    test('matches TNT Sports 1 when user searches "tnt 1"', async () => {
      const { handleCatalog } = require('../src/catalog');
      const container = require('../src/container');
      const cache = container.resolve('cacheService');

      const tntMatch = new MatchEntity({
        id: 'dlv_ch_tnt1',
        title: 'TNT Sports 1',
        baseTitle: 'TNT Sports 1',
        canonicalTitle: 'TNT Sports 1',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'daddylive', channelName: 'TNT Sports 1 HD' }]
      });

      const skyMatch = new MatchEntity({
        id: 'dlv_ch_sky1',
        title: 'Sky Sports Premier League',
        baseTitle: 'Sky Sports Premier League',
        canonicalTitle: 'Sky Sports Premier League',
        category: 'networks',
        date: '0',
        league: 'Live TV',
        sources: [{ source: 'daddylive', channelName: 'Sky Sports Premier League' }]
      });

      cache.setMatches([tntMatch, skyMatch]);

      const res = await handleCatalog('tv', 'nuvio_sports_networks', { search: 'tnt 1' }, {});
      expect(res.metas.length).toBe(1);
      expect(res.metas[0].name).toContain('TNT Sports 1');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 8: Intra-Card Stream Deduplication
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 8: Intra-Card Stream Deduplication', () => {
    test('deduplicates duplicate Vavoo streams for the same channel, keeping the higher scored stream', () => {
      const streams = [
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT Sports 1 — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/1/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'TNT Sports 1 — United Kingdom',
          score: 85,
          isBackup: false,
          _source: 'vavoo'
        },
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT Sports 1 Backup — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/2/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'TNT Sports 1 Backup — United Kingdom',
          score: 75,
          isBackup: true,
          _source: 'vavoo'
        }
      ];

      deduplicateResolutions(streams);
      expect(streams.length).toBe(1);
      expect(streams[0].isBackup).toBe(false);
      expect(streams[0].score).toBe(85);
    });

    test('deduplicates Vavoo streams across singular/plural brand variations (TNT SPORT 1 vs TNT SPORTS 1)', () => {
      const streams = [
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT SPORT 1 — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/1/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'TNT SPORT 1 — United Kingdom',
          score: 85,
          isBackup: false,
          _source: 'vavoo'
        },
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT SPORTS 1 — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/2/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'TNT SPORTS 1 — United Kingdom',
          score: 95,
          isBackup: false,
          _source: 'vavoo'
        },
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT SPORTS 1 HD — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/3/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'TNT SPORTS 1 HD — United Kingdom',
          score: 90,
          isBackup: false,
          _source: 'vavoo'
        }
      ];

      deduplicateResolutions(streams);
      expect(streams.length).toBe(1);
      expect(streams[0].score).toBe(95);
    });

    test('deduplicates Vavoo streams across singular/plural Sky Sport Premier League vs Sky Sports Premier League', () => {
      const streams = [
        {
          name: 'Vavoo',
          title: 'Vavoo (SKY SPORT PREMIER LEAGUE — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/sky1/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'SKY SPORT PREMIER LEAGUE',
          score: 80,
          isBackup: false,
          _source: 'vavoo'
        },
        {
          name: 'Vavoo',
          title: 'Vavoo (SKY SPORTS PREMIER LEAGUE — United Kingdom) [1080p]',
          url: 'https://vavoo.to/live2/play/sky2/index.m3u8',
          resolution: '1080p',
          language: 'English',
          channelName: 'SKY SPORTS PREMIER LEAGUE',
          score: 90,
          isBackup: false,
          _source: 'vavoo'
        }
      ];

      deduplicateResolutions(streams);
      expect(streams.length).toBe(1);
      expect(streams[0].score).toBe(90);
    });

    test('deduplicates streams with identical URLs for Vavoo', () => {
      const streams = [
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT Sports 1) [1080p]',
          url: 'https://vavoo.to/live2/play/same/index.m3u8',
          resolution: '1080p',
          _source: 'vavoo'
        },
        {
          name: 'Vavoo',
          title: 'Vavoo (TNT Sports 1 HD) [1080p]',
          url: 'https://vavoo.to/live2/play/same/index.m3u8',
          resolution: '1080p',
          _source: 'vavoo'
        }
      ];

      deduplicateResolutions(streams);
      expect(streams.length).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Pillar 9: Edge Case Channel Merging in MatchAggregator
  // ──────────────────────────────────────────────────────────────────────────
  describe('Pillar 9: Edge Case Channel Merging in MatchAggregator', () => {
    test('merges motorsport-branded 24/7 channels without being blocked by fixture series guards', () => {
      const agg = new MatchAggregator({});
      const c1 = new MatchEntity({
        id: 'dlv_ch_271_canal-motogp',
        title: 'Canal+ MotoGP',
        category: 'networks',
        date: '0',
        league: 'France',
        sources: [{ source: 'daddylive', channelName: 'Canal+ MotoGP France' }]
      });
      c1.channelIdentityKey = 'canalmotogp';
      c1.channelNumber = null;
      c1.canonicalTitle = 'Canal+ MotoGP';

      const c2 = new MatchEntity({
        id: 'vavoo_ch_canal-moto-gp-france',
        title: 'Canal+ Moto Gp',
        category: 'networks',
        date: '0',
        league: 'France',
        sources: [{ source: 'vavoo', channelName: 'CANAL+ MOTO GP' }]
      });
      c2.channelIdentityKey = 'canalmotogp';
      c2.channelNumber = null;
      c2.canonicalTitle = 'Canal+ MotoGP';

      expect(agg.isSameEvent(c1, c2)).toBe(true);
    });

    test('merges 2-character channel names without being rejected by word length filters (C8, M6, W9, FX, TF1)', () => {
      const agg = new MatchAggregator({});
      const channels = [
        { id1: 'dlv_ch_c8', id2: 'vavoo_ch_c8', name: 'C8', key: 'c8' },
        { id1: 'dlv_ch_m6', id2: 'vavoo_ch_m6', name: 'M6', key: 'm6' },
        { id1: 'dlv_ch_w9', id2: 'vavoo_ch_w9', name: 'W9', key: 'w9' },
        { id1: 'dlv_ch_fx', id2: 'vavoo_ch_fx', name: 'FX', key: 'fx' },
        { id1: 'dlv_ch_tf1', id2: 'vavoo_ch_tf1', name: 'TF1', key: 'tf1' }
      ];

      for (const ch of channels) {
        const m1 = new MatchEntity({
          id: ch.id1,
          title: ch.name,
          category: 'networks',
          date: '0',
          sources: [{ source: 'daddylive', channelName: ch.name }]
        });
        m1.channelIdentityKey = ch.key;
        m1.channelNumber = null;
        m1.canonicalTitle = ch.name;

        const m2 = new MatchEntity({
          id: ch.id2,
          title: ch.name,
          category: 'networks',
          date: '0',
          sources: [{ source: 'vavoo', channelName: ch.name }]
        });
        m2.channelIdentityKey = ch.key;
        m2.channelNumber = null;
        m2.canonicalTitle = ch.name;

        expect(agg.isSameEvent(m1, m2)).toBe(true);
      }
    });

    test('normalizes SKYS PORTS typo and Canal+ spacing in ChannelIdentityService', () => {
      const skys = ChannelIdentityService.parseChannel('SKYS PORTS MAIN EVENT');
      expect(skys.canonicalTitle).toBe('Sky Sports Main Event');
      expect(skys.identityKey).toBe('skysportmainevent');

      const canal = ChannelIdentityService.parseChannel('CANAL + SPORTS 1 HD');
      expect(canal.canonicalTitle).toBe('Canal+ Sport 1');
      expect(canal.identityKey).toBe('canalsport1');
      expect(canal.channelNumber).toBe('1');
    });
  });

});
