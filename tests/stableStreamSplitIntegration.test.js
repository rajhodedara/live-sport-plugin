'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual response middleware with in-memory request/response objects.
// Do not load the app, providers, native modules, workers or a listening server.
const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
const start = source.indexOf('const STREAM_PREFIXES =');
const end = source.indexOf('/**\n * Decodes a config URL segment.', start);

function rewriteResponse(body, streamBase = 'https://media.addon.example') {
  let middleware;
  let output;
  const headers = {};
  vm.runInNewContext(source.slice(start, end), {
    app: { use(value) { middleware = value; } },
    STREAM_BASE_URL: streamBase,
    getRequestBaseUrl: () => 'https://addon.example',
    Buffer
  });
  const res = {
    write() {},
    end(bytes) { output = bytes; },
    setHeader(name, value) { headers[name] = value; }
  };
  middleware({ path: '/stream/tv/fixture.json' }, res, () => {});
  res.end(JSON.stringify(body));
  return { body: JSON.parse(output.toString('utf8')), output, headers };
}

test('publishes relative and legacy absolute Leaf/manifest endpoints on the stream host', () => {
  const values = [
    '/api/leaf/manifest.m3u8?url=https%3A%2F%2Fupstream.example%2Flive.m3u8%3Ftoken%3Done%252Ftwo',
    'http://localhost:7000/api/leaf/manifest.m3u8?url=fixture',
    '/api/soccerfull/manifest?url=fixture',
    '/api/dash/index.m3u8?d=fixture',
    '/api/hls/resource/fixture/media.ts?psig=fixture',
    '/hls/resource/fixture/media.ts?psig=fixture'
  ];
  const { body, output, headers } = rewriteResponse({ streams: values.map(url => ({ url })) });
  expect(body.streams.map(stream => stream.url)).toEqual(values.map(url =>
    'https://media.addon.example' + url.replace(/^http:\/\/localhost:7000/, '')));
  expect(headers['Content-Length']).toBe(output.length);
});

test('keeps posters, metadata artwork and watch links on the addon host', () => {
  const { body } = rewriteResponse({
    metas: [{ poster: '/img/fixture?text=test', background: 'http://localhost:7000/posters/replays/fixture.jpg' }],
    meta: { logo: '/logo/fixture.png', videos: [{ thumbnail: '/posters/fixture.jpg' }] },
    streams: [{ externalUrl: '/watch?url=fixture' }]
  });
  expect(body.metas[0].poster).toBe('https://addon.example/img/fixture?text=test');
  expect(body.metas[0].background).toBe('https://addon.example/posters/replays/fixture.jpg');
  expect(body.meta.logo).toBe('https://addon.example/logo/fixture.png');
  expect(body.meta.videos[0].thumbnail).toBe('https://addon.example/posters/fixture.jpg');
  expect(body.streams[0].externalUrl).toBe('https://addon.example/watch?url=fixture');
});

test('falls back to the addon host when no dedicated stream host is configured', () => {
  const { body } = rewriteResponse({ streams: [{ url: '/api/leaf/manifest.m3u8?url=fixture' }] }, '');
  expect(body.streams[0].url).toBe('https://addon.example/api/leaf/manifest.m3u8?url=fixture');
});

test('does not hijack third-party generic HLS paths or endpoint-name lookalikes', () => {
  const values = [
    'https://cdn.example/hls/live/fixture.m3u8?token=fixture',
    'https://cdn.example/hls/resourceful/fixture.m3u8',
    'https://cdn.example/api/hls-other/fixture.m3u8',
    '/api/leaflet/fixture.m3u8',
    '/api/manifestation?url=fixture',
    '/posters-other/fixture.jpg',
    '//cdn.example/hls/live/fixture.m3u8'
  ];
  const { body } = rewriteResponse({ streams: values.map(url => ({ url })) });
  expect(body.streams.map(stream => stream.url)).toEqual(values);
});

test('preserves raw nested signed queries and fragments during host rewriting', () => {
  const suffix = '/api/leaf/manifest.m3u8?url=https%3A%2F%2Fupstream.example%2Flive.m3u8%3Fa%3Done%252Ftwo%26b%3Dthree%252Bfour#player';
  const { body } = rewriteResponse({ streams: [{ url: 'http://localhost:7000' + suffix }] });
  expect(body.streams[0].url).toBe('https://media.addon.example' + suffix);
});

test('keeps unchanged response bytes when no internal endpoint is present', () => {
  const value = { streams: [{ url: 'https://cdn.example/live.m3u8?token=fixture' }] };
  const { body, output, headers } = rewriteResponse(value);
  expect(body).toEqual(value);
  expect(output.toString('utf8')).toBe(JSON.stringify(value));
  expect(headers['Content-Length']).toBeUndefined();
});
