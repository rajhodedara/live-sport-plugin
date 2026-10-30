'use strict';
const { createNativeGuardedFetch } = require('../src/services/NativeGuardedFetch');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const operations = []; let created = 0;
  const pool = createNativeGuardedFetch({ maxSlots: 1, admissionWaitMs: 1000, slotOptions: { resolve: async () => ['93.184.216.34'] },
    createSlot: async () => { created++; return { busy: false, close: async () => {}, run: async (_url, fn) => {
      const hold = deferred(); operations.push(hold); return fn({ fetch: async () => { await hold.promise; return new Response('ok'); } });
    } }; }, ...options });
  return { pool, operations, count: () => created };
}
async function until(fn) { for (let i = 0; i < 50 && !fn(); i++) await turn(); expect(fn()).toBe(true); }
test('waits for release and reuses the bounded slot', async () => {
  const {pool, operations, count} = fixture(); const a = pool.fetch('https://cdn.example.org/a');
  let b;
  try {
    await until(() => operations.length === 1);
    b = pool.fetch('https://cdn.example.org/b'); await turn(); expect(operations).toHaveLength(1);
    operations[0].resolve(); await a; await until(() => operations.length === 2);
    expect(count()).toBe(1); operations[1].resolve(); await expect(b).resolves.toMatchObject({ status: 200 });
  } finally { operations.forEach(x => x.resolve()); await Promise.allSettled([a, ...(b ? [b] : [])]); await pool.close(); }
});
test('cancelled waiter is removed and a later waiter can proceed', async () => {
  const {pool, operations} = fixture(); const a = pool.fetch('https://cdn.example.org/a'); const abort = new AbortController();
  let b, c;
  try {
    await until(() => operations.length === 1);
    b = pool.fetch('https://cdn.example.org/b', {signal:abort.signal}); const rejected = expect(b).rejects.toThrow('cancelled'); await turn(); abort.abort(new Error('cancelled')); await rejected;
    c = pool.fetch('https://cdn.example.org/c'); await turn(); operations[0].resolve(); await a;
    await until(() => operations.length === 2); operations[1].resolve(); await expect(c).resolves.toMatchObject({status:200});
  } finally { operations.forEach(x => x.resolve()); await Promise.allSettled([a, ...(b ? [b] : []), ...(c ? [c] : [])]); await pool.close(); }
});
test('queue wait is bounded and does not create a second slot', async () => {
  const {pool, operations, count} = fixture({admissionWaitMs: 20}); const a = pool.fetch('https://cdn.example.org/a');
  try { await until(() => operations.length === 1); await expect(pool.fetch('https://cdn.example.org/b')).rejects.toMatchObject({code:'ERR_NATIVE_POOL_BUSY'}); expect(count()).toBe(1); }
  finally { operations.forEach(x => x.resolve()); await Promise.allSettled([a]); await pool.close(); }
});
test('request deadline expires while queued without allocating another slot', async () => {
  const {pool, operations, count} = fixture(); const a = pool.fetch('https://cdn.example.org/a');
  try { await until(() => operations.length === 1); await expect(pool.fetch('https://cdn.example.org/b',{timeoutMs:25})).rejects.toMatchObject({name:'TimeoutError'}); expect(count()).toBe(1); }
  finally { operations.forEach(x=>x.resolve()); await Promise.allSettled([a]); await pool.close(); }
});
test('a full queue rejects excess work without growing the slot count', async () => {
  const {pool, operations, count} = fixture({maxWaiters:1}); const a = pool.fetch('https://cdn.example.org/a'); let b;
  try { await until(()=>operations.length===1); b=pool.fetch('https://cdn.example.org/b'); await turn(); await expect(pool.fetch('https://cdn.example.org/c')).rejects.toMatchObject({code:'ERR_NATIVE_POOL_BUSY'}); expect(count()).toBe(1); operations[0].resolve(); await a; await until(()=>operations.length===2); operations[1].resolve(); await b; }
  finally { operations.forEach(x=>x.resolve()); await Promise.allSettled([a,...(b?[b]:[])]); await pool.close(); }
});
test('close aborts a queued caller without allocating a new slot', async () => {
  const {pool, operations, count} = fixture(); const a=pool.fetch('https://cdn.example.org/a'); let b;
  try { await until(()=>operations.length===1); b=pool.fetch('https://cdn.example.org/b'); const rejected=expect(b).rejects.toBeDefined(); await turn(); const closing=pool.close(); await rejected; operations[0].resolve(); await Promise.allSettled([a]); await closing; expect(count()).toBe(1); }
  finally { operations.forEach(x=>x.resolve()); await Promise.allSettled([a,...(b?[b]:[])]); await pool.close(); }
});
test('a cancelled but draining slot remains occupied until its operation settles', async () => {
  const drain = deferred(); let busy=false, made=0, runs=0;
  const slot = { get busy(){return busy}, whenIdle:()=>drain.promise, close:async()=>{}, run:async (_url,fn,options)=>{
    runs++; if(runs===1){ busy=true; return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true})); }
    return fn({fetch:async()=>new Response('ok')});
  }};
  const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{made++;return slot;}});
  const abort=new AbortController(), a=pool.fetch('https://cdn.example.org/a',{signal:abort.signal}); let b;
  try { await until(()=>runs===1); const rejected=expect(a).rejects.toThrow('cancelled'); abort.abort(new Error('cancelled')); await rejected;
    b=pool.fetch('https://cdn.example.org/b'); await turn(); expect(runs).toBe(1); busy=false; drain.resolve(); await expect(b).resolves.toMatchObject({status:200}); expect(made).toBe(1);
  } finally {busy=false;drain.resolve();await Promise.allSettled([a,...(b?[b]:[])]);await pool.close();}
});
test('a cancelled eviction wakes queued work when retirement finishes', async () => {
  const retirement = deferred(); let created=0, closing=false;
  const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{
    const id=++created;return {busy:false,run:async(_url,fn)=>fn({fetch:async()=>new Response('ok')}),close:async()=>{if(id===1){closing=true;await retirement.promise;}}};
  }});
  const abort=new AbortController();let replacing, queued;
  try {
    await pool.fetch('https://cdn.example.org/a',{profile:'chrome'});
    replacing=pool.fetch('https://cdn.example.org/b',{profile:'vanilla',signal:abort.signal});
    await until(()=>closing);const rejected=expect(replacing).rejects.toThrow('cancelled'); abort.abort(new Error('cancelled')); await rejected;
    queued=pool.fetch('https://cdn.example.org/c',{profile:'chrome'});await turn();expect(created).toBe(1);
    retirement.resolve();await expect(queued).resolves.toMatchObject({status:200});expect(created).toBe(2);
  } finally {retirement.resolve();await Promise.allSettled([...(replacing?[replacing]:[]),...(queued?[queued]:[])]);await pool.close();}
});
test('a bounded burst drains without exceeding the four-slot limit', async () => {
  let made=0, active=0, peak=0;
  const pool=createNativeGuardedFetch({maxSlots:4,maxWaiters:32,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{
    made++;let busy=false;return {get busy(){return busy},close:async()=>{},run:async(_url,fn)=>{busy=true;active++;peak=Math.max(peak,active);try{return await fn({fetch:async()=>{await turn();return new Response('ok')}});}finally{active--;busy=false;}}};
  }});
  try {const results=await Promise.all(Array.from({length:20},(_,i)=>pool.fetch(`https://cdn.example.org/${i}`)));expect(results).toHaveLength(20);expect(results.every(x=>x.status===200)).toBe(true);expect(made).toBeLessThanOrEqual(4);expect(peak).toBeLessThanOrEqual(4);}
  finally {await pool.close();}
});
test('failed slot creation releases capacity for a queued request', async () => {
  let rejectCreation, made=0;
  const creation=new Promise((_resolve,reject)=>{rejectCreation=reject});
  const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{
    if(++made===1)return creation;
    return {busy:false,run:async(_url,fn)=>fn({fetch:async()=>new Response('ok')}),close:async()=>{}};
  }});
  const a=pool.fetch('https://cdn.example.org/a'); const failed=expect(a).rejects.toThrow('creation failed'); let b;
  try {await until(()=>made===1); b=pool.fetch('https://cdn.example.org/b'); await turn(); rejectCreation(new Error('creation failed')); await failed; await expect(b).resolves.toMatchObject({status:200});expect(made).toBe(2);}
  finally {rejectCreation(new Error('cleanup')); await Promise.allSettled([a,...(b?[b]:[])]);await pool.close();}
});
test('mixed profile burst completes without crossing the slot cap or closing busy slots', async () => {
  let open=0, peakOpen=0, active=0, peakActive=0, closes=0;
  const pool=createNativeGuardedFetch({maxSlots:4,maxWaiters:128,admissionWaitMs:3000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{
    open++;peakOpen=Math.max(peakOpen,open);let busy=false,closed=false;
    return {get busy(){return busy},close:async()=>{expect(busy).toBe(false);expect(closed).toBe(false);closed=true;closes++;open--;},run:async(_url,fn)=>{expect(closed).toBe(false);busy=true;active++;peakActive=Math.max(peakActive,active);try{return await fn({fetch:async()=>{await turn();return new Response('ok')}});}finally{active--;busy=false;}}};
  }});
  try {
    const results=await Promise.all(Array.from({length:60},(_,i)=>pool.fetch(`https://cdn.example.org/${i}`,{profile:i%2?'chrome':'vanilla'})));
    expect(results).toHaveLength(60);expect(results.every(x=>x.status===200)).toBe(true);expect(peakOpen).toBeLessThanOrEqual(4);expect(peakActive).toBeLessThanOrEqual(4);
  } finally {await pool.close();}
  expect(open).toBe(0);expect(closes).toBeGreaterThan(0);
});
