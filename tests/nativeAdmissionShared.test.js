'use strict';
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');
const { createSharedOutboundFetch } = require('../src/services/SharedOutboundFetch');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(fn) { for (let i = 0; i < 50 && !fn(); i++) await turn(); expect(fn()).toBe(true); }
function setup(options = {}) {
  const holds = []; let created = 0;
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 1000, slotOptions: { resolve: async () => ['93.184.216.34'] }, createSlot: async () => {
    created++; return { busy: false, close: async () => {}, run: async (_url, fn) => {
      const hold = deferred(); holds.push(hold); return fn({ fetch: async () => { await hold.promise; return new Response('fixture'); } });
    } };
  }, ...options });
  const fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch: (url, opts) => pool.fetch(url, opts), fallbackFetch });
  return { holds, pool, fetch, fallbackFetch, created: () => created };
}
test('shared transport waits and succeeds without fallback after native capacity releases', async () => {
  const f = setup(); const a = f.fetch('https://cdn.example.org/a', { attempts: 1 }); let b;
  try { await until(() => f.holds.length === 1); b = f.fetch('https://cdn.example.org/b', { attempts: 1 }); await turn(); expect(f.holds).toHaveLength(1);
    f.holds[0].resolve(); await a; await until(() => f.holds.length === 2); f.holds[1].resolve(); expect((await b).status).toBe(200); expect(f.created()).toBe(1); expect(f.fallbackFetch).not.toHaveBeenCalled();
  } finally { f.holds.forEach(x => x.resolve()); await Promise.allSettled([a, ...(b ? [b] : [])]); await f.pool.close(); }
});
test('shared transport reports a bounded capacity failure without direct fallback', async () => {
  const f = setup({ admissionWaitMs: 20 }); const a = f.fetch('https://cdn.example.org/a', { attempts: 1 });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try { await until(() => f.holds.length === 1); await expect(f.fetch('https://cdn.example.org/b', { attempts: 1, diagnosticOwner: 'catalog' })).rejects.toMatchObject({ code: 'ERR_OUTBOUND_CAPACITY', transportCode: 'ERR_NATIVE_POOL_BUSY' }); expect(f.fallbackFetch).not.toHaveBeenCalled(); }
  finally { warn.mockRestore(); f.holds.forEach(x => x.resolve()); await Promise.allSettled([a]); await f.pool.close(); }
});
test('shared queued cancellation removes the caller without fallback or a second slot', async () => {
  const f = setup(); const a = f.fetch('https://cdn.example.org/a', { attempts: 1 });
  const abort = new AbortController(); let b;
  try { await until(() => f.holds.length === 1); b = f.fetch('https://cdn.example.org/b', { attempts: 1, signal: abort.signal }); const rejected = expect(b).rejects.toThrow('cancelled'); await turn(); abort.abort(new Error('cancelled')); await rejected;
    expect(f.fallbackFetch).not.toHaveBeenCalled(); expect(f.created()).toBe(1); expect(f.holds).toHaveLength(1);
  } finally { f.holds.forEach(x => x.resolve()); await Promise.allSettled([a, ...(b ? [b] : [])]); await f.pool.close(); }
});
