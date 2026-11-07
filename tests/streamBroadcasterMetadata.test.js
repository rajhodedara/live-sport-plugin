'use strict';

// Offline output-shaping regressions. No upstream embeds, native clients or
// HTTP servers; provider and cache boundaries are mocked in memory.
jest.mock('../src/container', () => ({ resolve: jest.fn(), hasRegistration: () => false }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
jest.mock('../src/services/HlsRewriteService', () => ({}));
jest.mock('../src/services/TimingRuntime', () => ({ relations: null }));
jest.mock('../src/catalog', () => ({ isReplayMatch: () => false }));
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));

const container = require('../src/container');
const { execFile } = require('child_process');
const { handleStream } = require('../src/streams');
const Cache = require('../src/services/StreamResolveCache');
const PpvStProvider = require('../src/providers/PpvStProvider');
const MATCH = 'Formula 1: São Paulo Grand Prix - Practice 1';

const event = source => ({
  id: 'sao-paulo-f1-practice',
  title: MATCH,
  baseTitle: MATCH,
  category: 'motorsport',
  date: String(Date.now()),
  sources: [{ source, id: 'fixture-1', channelName: 'Sky Sports F1', language: 'en' }]
});
let services, oldDonation;
beforeEach(() => {
  oldDonation = process.env.DONATION_URL;
  process.env.DONATION_URL = 'disabled';
  services = {
    streamResolveCache: new Cache({ sharedResolver: { available: () => false } }),
    streamScorer: { calculateScore: () => 42 },
    m3u8Parser: null,
    cacheService: { findMatch: () => event('pitsport') }
  };
  container.resolve.mockImplementation(name => services[name]);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  if (oldDonation === undefined) delete process.env.DONATION_URL;
  else process.env.DONATION_URL = oldDonation;
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('PitSport explicit broadcaster beats the fixture in the first title parentheses', async () => {
  services.pitSportProvider = { resolveStream: jest.fn(async () => [{
    name: 'PitSport', _source: 'pitsport',
    title: `PitSport - Sky Sports F1 (${MATCH})`,
    channelName: 'Sky Sports F1',
    url: 'https://cdn.fixture.test/stream.mp4',
    resolution: '1080p'
  }]) };
  const response = await handleStream('tv', 'nuvio_sport_sao-paulo-f1-practice', {});
  const direct = response.streams.find(s => s.name === '⚡ Direct Stream');
  expect(direct).toBeDefined();
  expect(direct.title).toContain('📺 Sky Sports F1');
  expect(direct.title).toContain('1080p');
  expect(direct.title).not.toContain(`📺 ${MATCH}`);
});

test('a known event title never becomes a fake broadcaster without metadata', async () => {
  services.pitSportProvider = { resolveStream: jest.fn(async () => [{
    name: 'PitSport', _source: 'pitsport',
    title: `PitSport - Feed (${MATCH})`,
    url: 'https://cdn.fixture.test/stream.mp4'
  }]) };
  const response = await handleStream('tv', 'nuvio_sport_sao-paulo-f1-practice', {});
  const direct = response.streams.find(s => s.name === '⚡ Direct Stream');
  expect(direct).toBeDefined();
  expect(direct.title).not.toContain(`📺 ${MATCH}`);
});

test('PPV.st explicit locale is visible without inventing a country', async () => {
  services.cacheService.findMatch = () => event('ppvst');
  services.ppvStProvider = { resolveStream: jest.fn(async () => [{
    name: 'PpvSt', _source: 'ppvst',
    title: `PpvSt [ES] - DAZN F1 (${MATCH})`,
    channelName: 'DAZN F1', language: 'es',
    url: 'https://cdn.fixture.test/stream.mp4',
    resolution: '720p'
  }]) };
  const response = await handleStream('tv', 'nuvio_sport_sao-paulo-f1-practice', {});
  const direct = response.streams.find(s => s.name === '⚡ Direct Stream');
  expect(direct).toBeDefined();
  expect(direct.title).toContain('📺 DAZN F1');
  expect(direct.title).toContain('Spanish');
  expect(direct.title).toContain('720p');
  expect(direct.title).not.toContain(`📺 ${MATCH}`);
});

test('PPV.st provider retains catalog broadcaster and locale for both extracted and web rows', async () => {
  execFile.mockImplementation((_binary, _args, _opts, callback) =>
    callback(null, '{"file":"https://cdn.fixture.test/direct.m3u8"}', ''));
  const provider = new PpvStProvider();
  const streams = await provider.resolveStream('fixture-1', 'motorsport', MATCH, {
    embedUrl: 'https://taifood-blog.asia/embed/fixture-1',
    channelName: 'Sky Sports F1', language: 'en'
  });
  expect(streams).toHaveLength(2);
  expect(streams.map(s => s.channelName)).toEqual(['Sky Sports F1', 'Sky Sports F1']);
  expect(streams.map(s => s.language)).toEqual(['en', 'en']);
  expect(execFile).toHaveBeenCalledTimes(1);
});
