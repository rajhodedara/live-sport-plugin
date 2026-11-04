'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const start = source.indexOf('const rewriteUrl = (url) =>');
const end = source.indexOf('// 1. Streams payload', start);
const prefixStart = source.indexOf('const STREAM_PREFIXES =');
const prefixEnd = source.indexOf('app.use((req, res, next) => {', prefixStart);
const prefixSetup = source.slice(prefixStart, prefixEnd);
const rewrite = vm.runInNewContext(prefixSetup + 'let modified = false; const currentBaseUrl = "https://addon.example"; const effectiveStreamBaseUrl = currentBaseUrl; ' + source.slice(start, end) + '; rewriteUrl');
test.each(['/api/soccerfull/manifest?url=https%3A%2F%2Fcdn.example%2Fa.m3u8', 'http://localhost:7000/api/soccerfull/manifest?url=https%3A%2F%2Fcdn.example%2Fa.m3u8'])('publishes the SoccerFull manifest with the request base: %s', value => {
  expect(rewrite(value)).toBe('https://addon.example/api/soccerfull/manifest?url=https%3A%2F%2Fcdn.example%2Fa.m3u8');
});
test('ordinary upstream playlists remain unchanged', () => {
  expect(rewrite('https://cdn.example/live.m3u8')).toBe('https://cdn.example/live.m3u8');
});
test('the response fast path scans for SoccerFull manifest URLs', () => {
  const prefixes = vm.runInNewContext(prefixSetup + '; REWRITE_SCAN_PREFIXES');
  expect(prefixes.some(prefix => '/api/soccerfull/manifest'.includes(prefix))).toBe(true);
});
