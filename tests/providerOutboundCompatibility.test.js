'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
jest.mock('../src/services/GuardedOutbound', () => ({ guardedRequest: jest.fn() }));
const { safeFetch: transport } = require('../src/impitClient');
const outbound = require('../src/services/ProviderOutbound');
const bytes = text => Uint8Array.from(Buffer.from(text)).buffer;
beforeEach(() => {
  transport.mockReset();
  transport.mockResolvedValue({ status: 200, ok: true, headers: new Headers({ 'X-Metadata': 'fixture' }),
    url: 'https://cdn.example.org/final', bodyTruncated: false, arrayBuffer: async () => bytes('{"value":42}') });
});

test('provider safeFetch cannot opt out of destination guarding', async () => {
  await outbound.safeFetch('https://cdn.example.org/', { guardExternal: false, headers: { Authorization: 'fixture' } });
  expect(transport.mock.calls[0][1]).toMatchObject({ guardExternal: true, headers: { Authorization: 'fixture' } });
});
test('Undici compatibility preserves statusCode, lower-case headers and single-use JSON', async () => {
  const response = await outbound.request('https://cdn.example.org/', { headersTimeout: 4000, bodyTimeout: 5000 });
  expect(transport.mock.calls[0][1]).toMatchObject({ guardExternal: true, transport: 'undici', attempts: 1, timeoutMs: 4000, redirect: 'manual' });
  expect(response.statusCode).toBe(200); expect(response.headers['x-metadata']).toBe('fixture');
  expect(await response.body.json()).toEqual({ value: 42 });
  await expect(response.body.text()).rejects.toThrow('already consumed');
});
test('Undici drain and binary reads remain available without another fetch', async () => {
  const response = await outbound.request('https://cdn.example.org/', { maxRedirections: 3 });
  expect(transport.mock.calls[0][1].redirect).toBe('follow');
  expect(Buffer.from(await response.body.arrayBuffer()).toString()).toBe('{"value":42}');
  await response.body.dump(); expect(transport).toHaveBeenCalledTimes(1);
});
test('Fetch compatibility exposes Headers, binary data and the final URL', async () => {
  const response = await outbound.fetch('https://cdn.example.org/entry');
  expect(response).toBeInstanceOf(Response); expect(response.url).toBe('https://cdn.example.org/final');
  expect(response.redirected).toBe(true); expect(response.headers.get('x-metadata')).toBe('fixture');
  expect(await response.json()).toEqual({ value: 42 });
});
test('Fetch Request input preserves method, protobuf bytes and headers', async () => {
  const input = new Request('https://cdn.example.org/api', { method: 'POST', body: Uint8Array.from([0, 1, 255]),
    headers: { 'Content-Type': 'application/x-protobuf' } });
  await outbound.fetch(input);
  expect(transport.mock.calls[0][1].method).toBe('POST');
  expect(transport.mock.calls[0][1].body).toEqual(Buffer.from([0, 1, 255]));
  expect(new Headers(transport.mock.calls[0][1].headers).get('content-type')).toBe('application/x-protobuf');
});
test('Fetch compatibility permits bodyless HTTP status responses', async () => {
  transport.mockResolvedValue({ status: 204, headers: {}, bodyTruncated: false });
  const response = await outbound.fetch('https://cdn.example.org/');
  expect(response.status).toBe(204); expect(await response.text()).toBe('');
});

test('the streaming probe keeps a readable body and cancel closes the guarded source', async () => {
  const { Readable } = require('node:stream');
  let closed = false;
  const body = new Readable({
    read() { this.push(Buffer.from('fixture')); },
    destroy(_error, callback) { closed = true; callback(); }
  });
  require('../src/services/GuardedOutbound').guardedRequest.mockResolvedValue({ statusCode: 200, headers: {}, body });
  const response = await outbound.streamingFetch('https://cdn.example.org/probe');
  const reader = response.body.getReader();
  expect((await reader.read()).value.byteLength).toBeGreaterThan(0);
  await reader.cancel(); expect(closed).toBe(true);
});
