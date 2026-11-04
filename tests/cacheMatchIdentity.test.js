'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CacheService = require('../src/services/CacheService');

let dir, cache;
const event = (id, title, sourceId, extra = {}) => ({
  id, title, category: 'football', sources: [{ source: 'test', id: sourceId }], ...extra
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-lookup-'));
  cache = new CacheService(path.join(dir, 'empty.json'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('canonical IDs select their own source even when a legacy source ID is shared', () => {
  cache.cachedMatches = [event('a', 'Arsenal vs Chelsea', 'shared'), event('b', 'Liverpool vs Everton', 'shared')];
  expect(cache.findMatch('a').title).toBe('Arsenal vs Chelsea');
  expect(cache.findMatch('b').title).toBe('Liverpool vs Everton');
  expect(cache.findMatch('shared')).toBeNull();
  expect(cache.findMatch('stream_shared')).toBeNull();
});

test('ambiguous alias and duplicate canonical ID never fall through to another lookup', () => {
  cache.cachedMatches = [event('same', 'Arsenal vs Chelsea', 'source-a', { aliasIds: ['alias'] }), event('same', 'Liverpool vs Everton', 'alias', { aliasIds: ['alias'] })];
  expect(cache.findMatch('same')).toBeNull();
  expect(cache.findMatch('alias')).toBeNull();
});

test('exact canonical identity wins over another event alias', () => {
  cache.cachedMatches = [event('a', 'Arsenal vs Chelsea', 'source-a'), event('b', 'Liverpool vs Everton', 'source-b', { aliasIds: ['a'] })];
  expect(cache.findMatch('a').title).toBe('Arsenal vs Chelsea');
});

test('numeric prefixes cannot select another source number', () => {
  cache.cachedMatches = [event('a', 'Arsenal vs Chelsea', '1210')];
  expect(cache.findMatch('121')).toBeNull();
  expect(cache.findMatch('stream_121')).toBeNull();
  expect(cache.findMatch('1210').id).toBe('a');
});

test('legacy source tokens require boundaries and a unique event', () => {
  cache.cachedMatches = [event('a', 'Arsenal vs Chelsea', 'old-feed-main')];
  expect(cache.findMatch('feed').id).toBe('a');
  expect(cache.findMatch('fee')).toBeNull();
  cache.cachedMatches = [...cache.cachedMatches, event('b', 'Liverpool vs Everton', 'other-feed-backup')];
  expect(cache.findMatch('feed')).toBeNull();
});

test('a URL parameter is not a legacy source identity', () => {
  cache.cachedMatches = [event('a', 'Arsenal vs Chelsea', 'https://example.test/feed?token=121')];
  expect(cache.findMatch('121')).toBeNull();
});

test('a partial title shared across dates cannot choose the first fixture', () => {
  cache.cachedMatches = [event('day-one', 'Arsenal vs Chelsea', 'one', { date: '1793448000000' }), event('day-two', 'Arsenal vs Chelsea', 'two', { date: '1793534400000' })];
  expect(cache.findMatch('arsenal-vs-chelsea')).toBeNull();
  expect(cache.findMatch('arsenal')).toBeNull();
});

test('unique legacy slug, alias and source lookup remain isolated copies', () => {
  cache.cachedMatches = [event('baseball-fixture', 'Cleveland Guardians vs Detroit Tigers', 'clip-999', { aliasIds: ['legacy'] })];
  for (const query of ['cleveland-guardians', 'legacy', 'clip-999', 'stream_clip-999']) {
    const result = cache.findMatch(query);
    expect(result.id).toBe('baseball-fixture');
    result.sources[0].id = 'changed';
    expect(cache.findMatch(query).sources[0].id).toBe('clip-999');
  }
});

test('rebuilding indices removes earlier ambiguity', () => {
  cache.cachedMatches = [event('a', 'Arsenal vs Chelsea', 'shared'), event('b', 'Liverpool vs Everton', 'shared')];
  expect(cache.findMatch('shared')).toBeNull();
  cache.cachedMatches = [cache.cachedMatches[0]];
  expect(cache.findMatch('shared').id).toBe('a');
});
