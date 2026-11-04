'use strict';

jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('undici', () => ({ ...jest.requireActual('undici'), request: jest.fn() }));
const dns = require('node:dns');
const { Readable } = require('node:stream');
const { request } = require('undici');
const { guardedProbeFetch, buildProbeSegmentUrl, readProbeBytes } = require('../src/streams');

beforeEach(() => {
  request.mockReset();
  jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => jest.restoreAllMocks());

test.each(['http://127.0.0.1/private', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/hostname'])('blocks %s without transport', async url => {
  await expect(guardedProbeFetch(url, { redirect: 'manual' })).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
  expect(request).not.toHaveBeenCalled();
});
test('does not follow a redirect to a private address in the speed probe', async () => {
  request.mockResolvedValueOnce({ statusCode: 302, headers: { location: 'http://127.0.0.1/private' }, body: Readable.from(['fixture']) });
  const response = await guardedProbeFetch('https://cdn.example.org/segment.ts', { redirect: 'manual' });
  expect(response.status).toBe(302);
  expect(request).toHaveBeenCalledTimes(1);
  await response.body.cancel();
});
test('keeps the direct segment URL and bounds a streaming sample', async () => {
  expect(buildProbeSegmentUrl('segment.ts', 'https://cdn.example.org/master.m3u8?token=fixture')).toBe('https://cdn.example.org/segment.ts?token=fixture');
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); controller.close(); } });
  expect(await readProbeBytes(stream, 16)).toBe(16);
});
