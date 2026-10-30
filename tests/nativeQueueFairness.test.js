'use strict';
const { createNativeGuardedFetch }=require('../src/services/NativeGuardedFetch');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let i=0;i<60&&!fn();i++)await turn();expect(fn()).toBe(true);}

test('records the order of waiting callers while the first slot is initializing',async()=>{
 const initializing=deferred(), firstWork=deferred(), order=[]; let started=false;
 const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{
   started=true;await initializing.promise;
   return {busy:false,close:async()=>{},run:async(url,fn)=>{order.push(new URL(url).pathname);return fn({fetch:async()=>{if(order.length===1)await firstWork.promise;return new Response('ok')}})}};
 }});
 const a=pool.fetch('https://cdn.example.org/a');let b,c;
 try{
  await until(()=>started);b=pool.fetch('https://cdn.example.org/b');await turn();c=pool.fetch('https://cdn.example.org/c');await turn();
  initializing.resolve();await until(()=>order.length===1);await turn();firstWork.resolve();
  await Promise.all([a,b,c]);
  expect(order).toEqual(['/a','/b','/c']);
 } finally{initializing.resolve();firstWork.resolve();await Promise.allSettled([a,...(b?[b]:[]),...(c?[c]:[])]);await pool.close();}
});
test('new arrivals remain behind existing waiters across slot releases',async()=>{
 const holds=[],order=[];
 const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>({busy:false,close:async()=>{},run:async(url,fn)=>{order.push(new URL(url).pathname);const d=deferred();holds.push(d);return fn({fetch:async()=>{await d.promise;return new Response('ok')}})}})});
 const a=pool.fetch('https://cdn.example.org/a');let b,c,d;
 try{
  await until(()=>holds.length===1);b=pool.fetch('https://cdn.example.org/b');await turn();c=pool.fetch('https://cdn.example.org/c');await turn();
  holds[0].resolve();await until(()=>holds.length===2);d=pool.fetch('https://cdn.example.org/d');await turn();
  holds[1].resolve();await until(()=>holds.length===3);holds[2].resolve();await until(()=>holds.length===4);holds[3].resolve();
  await Promise.all([a,b,c,d]);expect(order).toEqual(['/a','/b','/c','/d']);
 }finally{holds.forEach(x=>x.resolve());await Promise.allSettled([a,...(b?[b]:[]),...(c?[c]:[]),...(d?[d]:[])]);await pool.close();}
});
test('earlier mixed-profile waiter is not overtaken during retirement', async () => {
 const firstWork=deferred(), retirement=deferred(), order=[];let created=0, closing=false;
 const pool=createNativeGuardedFetch({maxSlots:1,admissionWaitMs:1000,slotOptions:{resolve:async()=>['93.184.216.34']},createSlot:async()=>{
   const id=++created;return {busy:false,close:async()=>{if(id===1){closing=true;await retirement.promise;}},run:async(url,fn)=>{order.push(new URL(url).pathname);return fn({fetch:async()=>{if(order.length===1)await firstWork.promise;return new Response('ok')}})}};
 }});
 const a=pool.fetch('https://cdn.example.org/a',{profile:'chrome'});let b,c;
 try{
  await until(()=>order.length===1);b=pool.fetch('https://cdn.example.org/b',{profile:'vanilla'});await turn();c=pool.fetch('https://cdn.example.org/c',{profile:'chrome'});await turn();
  firstWork.resolve();await until(()=>closing);retirement.resolve();await Promise.all([a,b,c]);expect(order).toEqual(['/a','/b','/c']);
 }finally{firstWork.resolve();retirement.resolve();await Promise.allSettled([a,...(b?[b]:[]),...(c?[c]:[])]);await pool.close();}
});
