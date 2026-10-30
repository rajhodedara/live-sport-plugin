'use strict';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
jest.mock('child_process', () => ({ execFile: jest.fn() }));
const { execFile } = require('child_process');
const PpvStProvider = require('../src/providers/PpvStProvider');

const source = { embedUrl: 'https://embed.example.test/embed/channel', channelName: 'Fixture' };
afterEach(() => jest.restoreAllMocks());

test('a successfully completed extractor produces a manifest stream', async () => {
  execFile.mockImplementation((node, args, options, done) => {
    done(null, 'JWPLAYER SETUP CALLED WITH: {"file": "https://cdn.example.test/live.m3u8?token=fixture"}', '');
  });
  const streams = await new PpvStProvider({}).resolveStream('id', 'football', 'Fixture', source);
  expect(streams).toHaveLength(1);
  expect(streams[0].url).toContain('/api/manifest?');
  expect(decodeURIComponent(streams[0].url)).toContain('https://cdn.example.test/live.m3u8?token=fixture');
});

test('a failed extractor still yields the web-player fallback', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  execFile.mockImplementation((node, args, options, done) => done(new Error('failed'), '', 'failure'));
  const streams = await new PpvStProvider({}).resolveStream('id', 'football', 'Fixture', source);
  expect(streams).toHaveLength(1);
  expect(streams[0].externalUrl).toContain('/watch?');
});
