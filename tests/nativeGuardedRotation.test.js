'use strict';
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');

test('idle native clients rotate on the existing clock without changing the slot cap', async () => {
  let now = 1000, created = 0, closed = 0;
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, recycleMs: 600000, now: () => now,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => {
      created++;
      return { busy: false, run: (_url, operation) => operation({ fetch: async () => new Response('fixture') }),
        close: async () => { closed++; } };
    }
  });
  try {
    await pool.fetch('https://cdn.example.org/metadata');
    now += 600001;
    expect(await (await pool.fetch('https://cdn.example.org/metadata')).text()).toBe('fixture');
    expect(created).toBe(2); expect(closed).toBe(1); expect(pool.stats.slots).toBe(1);
  } finally { await pool.close(); }
  expect(closed).toBe(2);
});

test('an expired client is not retired underneath an unsettled request', async () => {
  let now = 1000, finish, closed = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, recycleMs: 600000, now: () => now,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ busy: false,
      run: (_url, operation) => operation({ fetch: () => { started(); return new Promise(resolve => { finish = resolve; }); } }),
      close: async () => { closed++; } })
  });
  try {
    const pending = pool.fetch('https://cdn.example.org/metadata');
    await ready; now += 600001;
    await expect(pool.fetch('https://cdn.example.org/metadata')).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
    expect(closed).toBe(0);
    finish(new Response('fixture')); expect(await (await pending).text()).toBe('fixture');
  } finally { await pool.close(); }
  expect(closed).toBe(1);
});

test('capacity diagnostic identifies holder and masks proxy credentials', async () => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ busy: false, run: (_url, op) => op({ fetch: () => { started(); return new Promise(resolve => { finish = resolve; }); } }), close: async () => {} })
  });
  try {
    const pending = pool.fetch('https://cdn.example.org/a', { profile: 'vanilla', proxyUrl: 'socks5://user:secret@127.0.0.1:40000', diagnosticOwner: 'wasm' });
    await ready;
    let failure;
    try { await pool.fetch('https://cdn.example.org/b', { profile: 'vanilla', proxyUrl: 'socks5://user:secret@127.0.0.1:40000', diagnosticOwner: 'manifest' }); } catch (err) { failure = err; }
    expect(failure.code).toBe('ERR_NATIVE_POOL_BUSY');
    expect(failure.capacityDiagnostic).toMatchObject({ limit: 1, requested: { profile: 'vanilla', egress: 'proxy', owner: 'manifest' }, slots: [{ profile: 'vanilla', egress: 'proxy', owner: 'wasm', state: 'reserved' }] });
    expect(JSON.stringify(failure.capacityDiagnostic)).not.toMatch(/secret|127\.0\.0\.1|cdn\.example/);
    finish(new Response('fixture')); await pending;
  } finally { await pool.close(); }
});

test('idle direct slots are reclaimed for a proxy key without exceeding the pool cap', async () => {
  let created = 0, closed = 0;
  const profiles = [];
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async config => { created++; profiles.push(config.profile); return { busy: false, run: (_url, op) => op({ fetch: async () => new Response('ok') }), close: async () => { closed++; } }; }
  });
  try {
    await pool.fetch('https://cdn.example.org/a', { profile: 'chrome', proxyUrl: null });
    expect(pool.stats).toEqual({ slots: 1, busy: 0 });
    expect(await (await pool.fetch('https://cdn.example.org/b', { profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' })).text()).toBe('ok');
    expect(profiles).toEqual(['chrome', 'vanilla']); expect(created).toBe(2); expect(closed).toBe(1);
    expect(pool.stats).toEqual({ slots: 1, busy: 0 });
  } finally { await pool.close(); }
});

test('a busy slot is never evicted for a different key', async () => {
  let finish, started, closed = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ busy: false, run: (_url, op) => op({ fetch: () => { started(); return new Promise(resolve => { finish = resolve; }); } }), close: async () => { closed++; } })
  });
  try {
    const pending = pool.fetch('https://cdn.example.org/a', { profile: 'chrome', proxyUrl: null }); await ready;
    await expect(pool.fetch('https://cdn.example.org/b', { profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
    expect(closed).toBe(0); finish(new Response('ok')); await pending;
  } finally { await pool.close(); }
});

test('a slot being closed for eviction cannot be reused or evicted twice', async () => {
  let releaseClose, startedClose, closes = 0, created = 0;
  const closeStarted = new Promise(resolve => { startedClose = resolve; });
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => { created++; const id = created; return { busy: false, run: (_url, op) => op({ fetch: async () => new Response('ok') }),
      close: async () => { closes++; if (id === 1) { startedClose(); await new Promise(resolve => { releaseClose = resolve; }); } } }; }
  });
  try {
    await pool.fetch('https://cdn.example.org/a', { profile: 'chrome' });
    const replacement = pool.fetch('https://cdn.example.org/b', { profile: 'vanilla' }); await closeStarted;
    await expect(pool.fetch('https://cdn.example.org/c', { profile: 'chrome' })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
    expect(closes).toBe(1); expect(created).toBe(1); releaseClose(); await replacement;
    expect(created).toBe(2); expect(pool.stats.slots).toBe(1);
  } finally { await pool.close(); }
});

test('a failed idle-slot close does not create a replacement or lose the slot', async () => {
  let created = 0, closeCalls = 0;
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => { created++; return { busy: false, run: (_url, op) => op({ fetch: async () => new Response('ok') }),
      close: async () => { closeCalls++; if (closeCalls === 1) throw new Error('close failed'); } }; }
  });
  try {
    await pool.fetch('https://cdn.example.org/a', { profile: 'chrome' });
    await expect(pool.fetch('https://cdn.example.org/b', { profile: 'vanilla' })).rejects.toThrow('close failed');
    expect(created).toBe(1); expect(pool.stats.slots).toBe(1);
  } finally { await pool.close(); }
});

test('capacity diagnostics identify an aging retirement without leaking addresses', async () => {
  let now = 1000, finishClose, beginClose, closed = 0;
  const closing = new Promise(resolve => { beginClose = resolve; });
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, now: () => now,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => ({ busy: false, run: (_url, op) => op({ fetch: async () => new Response('ok') }),
      close: () => { if (++closed === 1) { beginClose(); return new Promise(resolve => { finishClose = resolve; }); } return Promise.resolve(); } }) });
  try {
    await pool.fetch('https://private-origin.example.org/path?token=secret', { profile: 'chrome' });
    const pending = pool.fetch('https://private-origin.example.org/', { profile: 'vanilla', timeoutMs: 50 }).catch(error => error);
    await closing;
    now += 1234;
    let failure;
    try { await pool.fetch('https://other.example.org/', { profile: 'chrome' }); } catch (error) { failure = error; }
    expect(failure.capacityDiagnostic.slots[0]).toMatchObject({ state: 'reserved', phase: 'retiring', reservationAgeMs: 1234 });
    const slotId = failure.capacityDiagnostic.slots[0].slotId;
    now += 200;
    try { await pool.fetch('https://other.example.org/', { profile: 'chrome' }); } catch (error) { failure = error; }
    expect(failure.capacityDiagnostic.slots[0]).toMatchObject({ slotId, reservationAgeMs: 1434 });
    expect(JSON.stringify(failure.capacityDiagnostic)).not.toMatch(/private-origin|secret|other\.example/);
    expect(await pending).toMatchObject({ name: 'TimeoutError' });
    finishClose();
    await new Promise(resolve => setImmediate(resolve));
    expect(await (await pool.fetch('https://other.example.org/', { profile: 'vanilla' })).text()).toBe('ok');
  } finally { if (finishClose) finishClose(); await pool.close(); }
});

test('failed age-based retirement never removes an unclosed slot or creates a replacement', async () => {
  let now = 1000, created = 0, closeCalls = 0;
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 0, recycleMs: 600000, now: () => now,
    slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => { created++; return { busy: false, run: (_url, op) => op({ fetch: async () => new Response('ok') }),
      close: async () => { if (++closeCalls === 1) throw new Error('close failed'); } }; } });
  try {
    await pool.fetch('https://cdn.example.org/');
    now += 600001;
    await expect(pool.fetch('https://cdn.example.org/')).rejects.toThrow('close failed');
    let failure;
    try { await pool.fetch('https://cdn.example.org/'); } catch (error) { failure = error; }
    expect(failure.capacityDiagnostic.slots[0]).toMatchObject({ state: 'reserved', phase: 'retirement_failed' });
    expect(created).toBe(1); expect(pool.stats.slots).toBe(1);
  } finally { await pool.close(); }
});
