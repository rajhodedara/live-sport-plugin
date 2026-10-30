'use strict';
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');

test('native path strips custom headers at an origin boundary and does not restore them', async () => {
  const calls = [];
  const responses = [
    new Response('', { status: 302, headers: { location: '/same' } }),
    new Response('', { status: 302, headers: { location: 'https://other.example.org/next' } }),
    new Response('', { status: 302, headers: { location: 'https://origin.example.org/back' } }),
    new Response('ok', { status: 200 })
  ];
  const client = { fetch: jest.fn(async (url, options) => { calls.push({ url, headers: { ...options.headers } }); return responses.shift(); }) };
  const slot = { busy: false, run: async (_url, fn) => fn(client), close: async () => {} };
  const pool = createNativeGuardedFetch({ createSlot: async () => slot, slotOptions: { resolve: async () => ['93.184.216.34'] } });
  try {
    expect((await pool.fetch('https://origin.example.org/start', { headers: { 'X-Api-Key': 'fixture', Authorization: 'fixture', 'User-Agent': 'client', Range: 'bytes=0-1', Referer: 'https://private.example/path' } })).status).toBe(200);
    expect(calls[1].headers['x-api-key']).toBe('fixture');
    for (const call of calls.slice(2)) {
      expect(call.headers['x-api-key']).toBeUndefined(); expect(call.headers.authorization).toBeUndefined();
      expect(call.headers.referer).toBeUndefined(); expect(call.headers.range).toBe('bytes=0-1'); expect(call.headers['user-agent']).toBe('client');
    }
  } finally { await pool.close(); }
});
