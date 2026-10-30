'use strict';
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');

test('HTTP phase callback distinguishes response and body completion across redirects', async () => {
  const phases = [];
  const responses = [new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/next' } }), new Response('ok')];
  const pool = createNativeGuardedFetch({ maxSlots: 1, onPhase: (phase, hop) => phases.push({ phase, hop }),
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ busy: false, run: (_url, operation) => operation({ fetch: async () => responses.shift() }), close: async () => {} }) });
  try {
    expect(await (await pool.fetch('https://cdn.example.org/private')).text()).toBe('ok');
    expect(phases).toEqual([{ phase: 'fetch_start', hop: 0 }, { phase: 'response_received', hop: 0 },
      { phase: 'fetch_start', hop: 1 }, { phase: 'response_received', hop: 1 }, { phase: 'body_read_end', hop: 1 }]);
    expect(JSON.stringify(phases)).not.toMatch(/example|private/);
  } finally { await pool.close(); }
});

test('a phase callback failure cannot break the transport', async () => {
  const pool = createNativeGuardedFetch({ maxSlots: 1, onPhase: () => { throw new Error('observer'); },
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ busy: false, run: (_url, operation) => operation({ fetch: async () => new Response('ok') }), close: async () => {} }) });
  try { expect(await (await pool.fetch('https://cdn.example.org/')).text()).toBe('ok'); }
  finally { await pool.close(); }
});
