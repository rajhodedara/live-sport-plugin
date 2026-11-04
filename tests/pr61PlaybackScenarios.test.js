'use strict';
// Actual provider, source dispatch, verification, local cache and publication;
// extractor process and upstream responses are simulated. No player/network.
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
const container = require('../src/container');
const { execFile } = require('child_process');
const { safeFetch } = require('../src/services/ProviderOutbound');
const PpvStProvider = require('../src/providers/PpvStProvider');
const StreamResolveCache = require('../src/services/StreamResolveCache');
const Parser = require('../src/services/M3U8ParserService');
const { handleStream } = require('../src/streams');
const target = 'https://cdn.example.test/live.m3u8?token=synthetic';
const good = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const response = status => ({ status, text: async () => status === 200 ? good : 'denied' });
let provider, cache, oldDonation, log, warn;
beforeEach(() => {
  jest.useFakeTimers();
  oldDonation = process.env.DONATION_URL; process.env.DONATION_URL = 'disabled';
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  execFile.mockReset(); safeFetch.mockReset();
  execFile.mockImplementation((_node, _args, _options, done) => done(null, JSON.stringify({file:target}), ''));
  safeFetch.mockResolvedValue(response(200));
  provider = new PpvStProvider({}); cache = new StreamResolveCache();
  const match = { id:'scenario', title:'Example vs Other', category:'football', sources:[{source:'ppvst',id:'s1',embedUrl:'https://embed.example.test/embed/s1'}] };
  const services = { cacheService:{findMatch:()=>match}, streamScorer:{calculateScore:()=>0}, streamResolveCache:cache, m3u8Parser:new Parser(), ppvStProvider:provider };
  container.resolve.mockImplementation(name => services[name]);
});
afterEach(() => {
  if(oldDonation===undefined) delete process.env.DONATION_URL; else process.env.DONATION_URL=oldDonation;
  log.mockRestore(); warn.mockRestore(); jest.useRealTimers();
});
const request = config => handleStream('tv','nuvio_sport_scenario',config||{});

test('successful extraction and verification publish HLS and repeated request uses local cache',async()=>{
  const first=await request(); const second=await request();
  expect(first.streams).toHaveLength(1); expect(second.streams).toHaveLength(1);
  expect(new URL(first.streams[0].url).pathname).toBe('/api/manifest.m3u8');
  expect(new URL(first.streams[0].url).searchParams.get('url')).toBe(target);
  expect(execFile).toHaveBeenCalledTimes(1); expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(safeFetch.mock.calls[0][1].headers).toMatchObject({Referer:'https://embed.example.test/',Origin:'https://embed.example.test'});
});

test('a refused manifest leaves a labeled Web Player, keeps the short retry window and can recover',async()=>{
  safeFetch.mockResolvedValue(response(403));
  const first=await request();
  expect(first.streams).toHaveLength(1);
  expect(first.streams[0].externalUrl).toContain('/watch?');
  expect(first.streams[0].url).toBeUndefined();
  expect((await request({webStreams:'disabled'})).streams).toHaveLength(0);
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(cache.stats().hits).toBeGreaterThan(0);
  expect([...cache.entries.values()][0].expiresAt-Date.now()).toBeLessThanOrEqual(30000);
  await jest.advanceTimersByTimeAsync(30001);
  safeFetch.mockResolvedValue(response(200));
  expect((await request()).streams).toHaveLength(1);
  expect(execFile).toHaveBeenCalledTimes(2);
});

test('extractor failure returns its real Web Player fallback and settings apply to cached results',async()=>{
  execFile.mockImplementation((_node,_args,_options,done)=>done(new Error('synthetic extractor failure'),'',''));
  expect((await request()).streams.some(s=>s.externalUrl?.startsWith('/watch?'))).toBe(true);
  expect((await request({webStreams:'disabled'})).streams).toHaveLength(0);
  expect(execFile).toHaveBeenCalledTimes(1); expect(safeFetch).not.toHaveBeenCalled();
});
