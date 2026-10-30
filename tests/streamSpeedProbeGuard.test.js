'use strict';
jest.mock('../src/container', () => ({ resolve: jest.fn() }));
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: jest.fn(), streamingFetch: jest.fn() }));
const { streamingFetch } = require('../src/services/ProviderOutbound');
const { guardedProbeFetch, buildProbeSegmentUrl, readProbeBytes } = require('../src/streams');
afterEach(() => jest.resetAllMocks());
test('speed probe delegates to guarded streaming transport with its timeout and headers', async () => {
  const response = { status: 200, body: {} };
  streamingFetch.mockResolvedValue(response);
  const options = { timeoutMs: 1000, headers: { Range: 'bytes=0-1023' } };
  await expect(guardedProbeFetch('https://cdn.example/segment.ts', options)).resolves.toBe(response);
  expect(streamingFetch).toHaveBeenCalledWith('https://cdn.example/segment.ts', options);
});
test('guard rejections propagate without a fallback to plain fetch', async () => {
  const err = Object.assign(new Error('blocked'), { code: 'ERR_OUTBOUND_BLOCKED' });
  streamingFetch.mockRejectedValue(err);
  const plain = jest.spyOn(global, 'fetch');
  try { await expect(guardedProbeFetch('http://127.0.0.1/')).rejects.toBe(err); expect(plain).not.toHaveBeenCalled(); }
  finally { plain.mockRestore(); }
});
test('does not buffer a non-streaming response', async () => {
  const arrayBuffer = jest.fn();
  await expect(readProbeBytes({ arrayBuffer }, 1024)).resolves.toBe(0);
  expect(arrayBuffer).not.toHaveBeenCalled();
});
test('cancels the stream at the byte budget', async () => {
  const reader = { read: jest.fn().mockResolvedValue({ done: false, value: new Uint8Array(100) }), cancel: jest.fn().mockResolvedValue(), releaseLock: jest.fn() };
  expect(await readProbeBytes({ getReader: () => reader }, 16)).toBe(16);
  expect(reader.cancel).toHaveBeenCalledTimes(1); expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});

test('uses the upstream CDN URL rather than an addon redirect', () => {
  expect(buildProbeSegmentUrl('segment.image', 'https://cdn.example/live/index.m3u8?token=fixture')).toBe('https://cdn.example/live/segment.image?token=fixture');
});
