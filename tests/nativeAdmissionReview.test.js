'use strict';
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const dns = async () => ['93.184.216.34'];

test('four active slots reject the next request and allow a later retry after release', async () => {
  const holds = []; let made = 0;
  const createSlot = async () => {
    made++;
    return { busy: false, close: async () => {}, run: async (_url, work) => {
      const hold = deferred(); holds.push(hold);
      return work({ fetch: async () => { await hold.promise; return new Response('ok'); } });
    } };
  };
  const pool = createNativeGuardedFetch({ maxSlots: 4, admissionWaitMs: 0, createSlot, slotOptions: { resolve: dns } });
  const requests = Array.from({ length: 4 }, () => pool.fetch('https://cdn.example.org/x'));
  try {
    for (let i = 0; i < 20 && holds.length < 4; i++) await turn();
    expect(holds).toHaveLength(4);
    await expect(pool.fetch('https://cdn.example.org/x')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
    expect(made).toBe(4);
    holds[0].resolve(); await requests[0];
    const retry = pool.fetch('https://cdn.example.org/x');
    for (let i = 0; i < 20 && holds.length < 5; i++) await turn();
    expect(holds).toHaveLength(5); expect(made).toBe(4);
    holds[4].resolve(); await expect(retry).resolves.toMatchObject({ status: 200 });
  } finally {
    for (const h of holds) h.resolve(); await Promise.allSettled(requests); await pool.close();
  }
});

test('four initializing slots count against capacity before a client exists', async () => {
  const creations = []; const slots = [];
  const pool = createNativeGuardedFetch({ maxSlots: 4, admissionWaitMs: 0, slotOptions: { resolve: dns }, createSlot: async () => {
    const wait = deferred(); creations.push(wait); await wait.promise;
    const slot = { busy: false, run: async (_url, work) => work({ fetch: async () => new Response('ok') }), close: async () => {} };
    slots.push(slot); return slot;
  } });
  const requests = Array.from({ length: 4 }, () => pool.fetch('https://cdn.example.org/x'));
  try {
    for (let i = 0; i < 20 && creations.length < 4; i++) await turn();
    expect(creations).toHaveLength(4);
    await expect(pool.fetch('https://cdn.example.org/x')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
    expect(slots).toHaveLength(0);
  } finally {
    for (const c of creations) c.resolve(); await Promise.allSettled(requests); await pool.close();
  }
});

test('cancelling while a slot is creating keeps the slot counted until creation settles', async () => {
  const creation = deferred(); let made = 0;
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, slotOptions: { resolve: dns }, createSlot: async () => {
    made++; await creation.promise;
    return { busy: false, run: async (_url, work) => work({ fetch: async () => new Response('ok') }), close: async () => {} };
  } });
  const abort = new AbortController();
  const first = pool.fetch('https://cdn.example.org/x', { signal: abort.signal });
  try {
    for (let i = 0; i < 20 && !made; i++) await turn();
    expect(made).toBe(1);
    const rejected = expect(first).rejects.toThrow('cancelled');
    abort.abort(new Error('cancelled')); await rejected;
    await expect(pool.fetch('https://cdn.example.org/x')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
    creation.resolve();
    for (let i = 0; i < 10; i++) await turn();
    await expect(pool.fetch('https://cdn.example.org/x')).resolves.toMatchObject({ status: 200 });
    expect(made).toBe(1);
  } finally { creation.resolve(); await pool.close(); }
});
test('capacity diagnostics preserve explicit catalog attribution without revealing URLs', async () => {
  const hold=deferred(); let active=false;
  const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:0,slotOptions:{resolve:dns},createSlot:async()=>({busy:false,close:async()=>{},run:async(_url,work)=>{active=true;return work({fetch:async()=>{await hold.promise;return new Response('ok')}});}})});
  const a=pool.fetch('https://cdn.example.org/private?token=fixture',{diagnosticOwner:'catalog'});
  try {
    for(let i=0;i<20&&!active;i++)await turn();expect(active).toBe(true);
    let error;try{await pool.fetch('https://cdn.example.org/other',{diagnosticOwner:'catalog'});}catch(e){error=e;}
    expect(error).toMatchObject({code:'ERR_NATIVE_POOL_BUSY',capacityDiagnostic:{requested:{owner:'catalog'},slots:[{owner:'catalog'}]}});
    expect(JSON.stringify(error.capacityDiagnostic)).not.toMatch(/cdn\.example|fixture|private/);
  } finally {hold.resolve();await Promise.allSettled([a]);await pool.close();}
});
