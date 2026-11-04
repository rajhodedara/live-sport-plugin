'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({
  safeFetch: jest.fn(() => { throw new Error('Unexpected outbound request'); }),
  streamingFetch: jest.fn(() => { throw new Error('Unexpected outbound request'); })
}));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const CdnLiveProvider = require('../src/providers/CdnLiveProvider');
const CacheService = require('../src/services/CacheService');
const MatchAggregator = require('../src/services/MatchAggregator');

const header = 'Sunday 1st Nov 2026 - Schedule Time UK GMT';
const channels = [{channel_id: '54', channel_name: 'FOX USA'}];
const event = (league = 'NCAA', extra = {}) => ({
  time: '14:30', event: `${league} : Villanova vs Notre Dame`, channels, ...extra
});
const fakeCB = {wrap: (name, fn) => ({fire: (...args) => fn(...args)}), wrapSync: (name, fn) => ({fire: (...args) => fn(...args)})};
let directory;
beforeEach(() => {
  jest.useFakeTimers({now: new Date('2026-11-01T13:16:15Z')});
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daddy-real-identity-'));
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  fs.rmSync(directory, {recursive: true, force: true});
});
async function schedule(data) {
  const provider = new DaddyLiveProvider({circuitBreaker: fakeCB});
  provider.fetchSchedule = {fire: async () => data};
  provider.fetchChannels = {fire: async () => ''};
  return provider.getMatches();
}

test('real Villanova schedule variants keep distinct usable canonical links', async () => {
  const rows = await schedule({[header]: {College: [event(), event("Men's College Basketball", {
    channels: [...channels, {channel_id: '768', channel_name: 'FOXNY USA'}]
  })]}});
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(row => row.id)).size).toBe(2);
  const cache = new CacheService(path.join(directory, 'matches.json'));
  cache.setMatches(rows);
  for (const row of rows) {
    expect(cache.findMatch(row.id)?.league).toBe(row.league);
    expect(cache.findMatch(row.id)?.sources.map(s => s.id)).toEqual(row.sources.map(s => s.id));
  }
  // Missing squad metadata is still not permission to combine these rows.
  expect(new MatchAggregator({}).isSameEvent(rows[0], rows[1])).toBe(false);
  expect(cache.findMatch('dlv_54_villanova-vs-notre-dame')).toBeNull();
});

test('a unique old DaddyLive bookmark remains supported as an alias', async () => {
  const [row] = await schedule({[header]: {College: [event()]}});
  expect(row.id).toMatch(/^dlv_event_[a-f0-9]{24}$/);
  expect(row.aliasIds).toContain('dlv_54_villanova-vs-notre-dame');
  const cache = new CacheService(path.join(directory, 'matches.json'));
  cache.setMatches([row]);
  expect(cache.findMatch('dlv_54_villanova-vs-notre-dame')?.id).toBe(row.id);
});

test('channel order and added alternatives do not change fixture identity', async () => {
  const [first] = await schedule({[header]: {College: [event()]}});
  const [second] = await schedule({[header]: {College: [event('NCAA', {
    channels: [{channel_id: '768', channel_name: 'FOXNY USA'}, ...channels]
  })]}});
  expect(second.id).toBe(first.id);
  expect(second.sources.map(s => s.id)).toEqual(['768', '54']);
});

test('repeated fixtures with the same teams/channel get distinct kickoff identities', async () => {
  const rows = await schedule({[header]: {College: [event(), event('NCAA', {time: '20:30'})]}});
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(row => row.id)).size).toBe(2);
});

test.each([false, true])('missing strong fixture IDs never fall through to source lookup (exact=%s)', exact => {
  const strong = 'dlv_event_' + 'f'.repeat(24);
  const cache = new CacheService(path.join(directory, 'matches.json'));
  cache.setMatches([{id: 'other-event', title: 'Other vs Different', sources: [{source: 'other', id: exact ? strong : `feed-${strong}-backup`}]}]);
  expect(cache.findMatch(strong)).toBeNull();
});

test('explicit month-first promotional date is not published as today', async () => {
  const [row] = await schedule({[header]: {Boxing: [event('Boxing WBA', {
    time: '19:00', event: 'Boxing WBA : Tyson Fury vs Anthony Joshua Fight live on Friday, December 11, 2026',
    channels: [{channel_id: '5000', channel_name: 'Netflix'}]
  })]}});
  expect(Number(row.date)).toBe(Date.parse('2026-12-11T19:00:00Z'));
  expect(row.status).toBe('upcoming');
});

test('an explicit impossible date cannot silently inherit the daily header', async () => {
  const rows = await schedule({[header]: {Boxing: [event('Boxing WBA', {
    time: '19:00', event: 'Boxing WBA : Example vs Other, February 30, 2027'
  })]}});
  expect(rows).toEqual([]);
});

test.each([
  ['11 December 2026', '2026-12-11T01:00:00Z'],
  ['11 December, 2027', '2027-12-11T01:00:00Z']
])('day-first explicit date %s keeps its own midnight instead of daily rollover', async (date, expected) => {
  const [row] = await schedule({[header]: {Boxing: [event('Boxing WBA', {
    time: '01:00', event: `Boxing WBA : Example vs Other, ${date}`
  })]}});
  expect(Number(row.date)).toBe(Date.parse(expected));
});

test.each([
  ['435', 'Movistar Liga de Campeones', 'dlv_ch_435_movistar-liga-campeones'],
  ['918', 'DAZN FIFA Mundial de Clubes', 'dlv_ch_918_dazn-fifa-mundial-clubes'],
  ['437', 'Movistar Supercopa de España', 'dlv_ch_437_movistar-supercopa-espa-a']
])('old channel bookmark for %s survives the Spanish title correction', async (id, name, bookmark) => {
  const provider = new DaddyLiveProvider({circuitBreaker: fakeCB});
  provider.fetchSchedule = {fire: async () => null};
  provider.fetchChannels = {fire: async () => `<a href="/watch.php?id=${id}"><div class="card__title">${name}</div></a>`};
  const rows = await provider.getMatches();
  expect(rows).toHaveLength(1);
  const cache = new CacheService(path.join(directory, 'channels.json'));
  cache.setMatches(rows);
  expect(cache.findMatch(bookmark)?.sources[0].id).toBe(id);
});

test('CDN title-slug channel bookmarks survive the same country-word correction', async () => {
  const provider = new CdnLiveProvider({circuitBreaker: fakeCB});
  provider.fetchChannels = {fire: async () => ({channels: [{
    name: 'Movistar Liga de Campeones', code: 'es', status: 'online', url: 'https://channel.example.invalid/movistar'
  }]})};
  const rows = await provider.getChannelMatches();
  const cache = new CacheService(path.join(directory, 'cdn-channels.json'));
  cache.setMatches(rows);
  expect(cache.findMatch('cdn_ch_es_movistar-liga-campeones')?.id).toBe('cdn_ch_es_movistar-liga-de-campeones');
});
