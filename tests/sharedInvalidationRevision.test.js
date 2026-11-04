'use strict';
const {execFileSync}=require('node:child_process');
const path=require('node:path');
function scenario(body){
 return JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','--eval',`
 import {createRequire} from 'node:module';
 import {cacheGet,cacheSet,cacheDelete,cacheClaim} from './resolver/src/cache.js';
 process.env.RESOLVE_CACHE_SHARED='true';process.env.RESOLVER_TRUST_LEGACY_TCP='true';
 const require=createRequire(import.meta.url),Cache=require('./src/services/StreamResolveCache');
 const key='provider:match:source', deletes=[];
 const response=data=>({ok:true,json:async()=>data});
 const turn=()=>new Promise(r=>setImmediate(r));
 ${body}
 `],{cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],env:{...process.env}}));
}

test('a delayed invalidation cannot erase a newer publication',()=>{
 const r=scenario(`
  cacheSet(key,[{url:'old'}],60000);let release;
  global.fetch=async(raw,opts={})=>{
   const u=new URL(raw);
   if(opts.method==='PATCH'){deletes.push(u.searchParams.get('revision'));await new Promise(r=>release=r);return response(cacheDelete(key,undefined,u.searchParams.get('revision')||undefined));}
   return response(cacheGet(key));
  };
  const cache=new Cache();await cache.getOrCreate(key,async()=>[]);cache.noteFailure(key);
  await turn();cacheSet(key,[{url:'new'}],60000);release?.();await turn();await turn();
  console.log(JSON.stringify({current:cacheGet(key),deletes}));
 `);
 expect(r.current.streams).toEqual([{url:'new'}]);
 expect(r.deletes[0]).toMatch(/^[a-f0-9-]{36}$/i);
});

test('older resolver snapshots without revisions never receive an unconditional invalidation',()=>{
 const r=scenario(`
  global.fetch=async(_raw,opts={})=>{if(opts.method && opts.method!=='GET')deletes.push(opts.method);return response({status:'ok',streams:[{url:'old'}],expiresAt:Date.now()+60000});};
  const cache=new Cache();await cache.getOrCreate(key,async()=>[]);cache.noteFailure(key);await turn();
  console.log(JSON.stringify({deletes}));
 `);
 expect(r.deletes).toEqual([]);
});

test('matching invalidation removes only its publication and never an active claim',()=>{
 const r=scenario(`
  const old=cacheSet(key,[{url:'old'}],60000);
  const removed=cacheDelete(key,undefined,old.revision);
  const after=cacheGet(key);
  const next=cacheSet(key,[{url:'new'}],60000);
  const claim=cacheClaim(key,30000,true);
  const blocked=cacheDelete(key,undefined,next.revision);
  console.log(JSON.stringify({removed,after,blocked,current:cacheGet(key),duplicate:cacheClaim(key,30000,true)}));
 `);
 expect(r.removed.ok).toBe(true);expect(r.after.status).toBe('miss');
 expect(r.blocked.ok).toBe(false);expect(r.current.streams).toEqual([{url:'new'}]);
 expect(r.duplicate.ok).toBe(false);
});

test('failure during publication retracts only that exact published version',()=>{
 const r=scenario(`
  let release,publishing=false;
  global.fetch=async(raw,opts={})=>{
   const u=new URL(raw);
   if(u.searchParams.get('claim')==='1')return response(cacheClaim(key,30000,true));
   if(opts.method==='POST'){publishing=true;await new Promise(r=>release=r);const b=JSON.parse(opts.body);return response(cacheSet(key,b.streams,b.ttlMs,b.status,b.ownerToken));}
   if(opts.method==='PATCH'){deletes.push(u.searchParams.get('revision'));return response(cacheDelete(key,undefined,u.searchParams.get('revision')||undefined));}
   return response(cacheGet(key));
  };
  const cache=new Cache(),pending=cache.getOrCreate(key,async()=>[{url:'minted'}]);
  while(!publishing)await turn();cache.noteFailure(key);release();await pending;await turn();
  console.log(JSON.stringify({current:cacheGet(key),deletes,local:cache.get(key)}));
 `);
 expect(r.current.status).toBe('miss');expect(r.local).toBeNull();
 expect(r.deletes).toHaveLength(1);expect(r.deletes[0]).toMatch(/^[a-f0-9-]{36}$/i);
});

test('a locally published entry carries the revision used by a later invalidation',()=>{
 const r=scenario(`
  global.fetch=async(raw,opts={})=>{
   const u=new URL(raw);
   if(u.searchParams.get('claim')==='1')return response(cacheClaim(key,30000,true));
   if(opts.method==='POST'){const b=JSON.parse(opts.body);return response(cacheSet(key,b.streams,b.ttlMs,b.status,b.ownerToken));}
   if(opts.method==='PATCH'){deletes.push(u.searchParams.get('revision'));return response(cacheDelete(key,undefined,u.searchParams.get('revision')||undefined));}
   return response(cacheGet(key));
  };
  const cache=new Cache();await cache.getOrCreate(key,async()=>[{url:'minted'}]);
  const revision=cacheGet(key).revision;cache.noteFailure(key);await turn();await turn();
  console.log(JSON.stringify({revision,current:cacheGet(key),deletes}));
 `);
 expect(r.current.status).toBe('miss');expect(r.deletes).toEqual([r.revision]);
});

test('an older resolver replacing the peer rejects conditional invalidation without deleting data',()=>{
 const r=scenario(`
  cacheSet(key,[{url:'old'}],60000);
  global.fetch=async(_raw,opts={})=>{
   if(opts.method==='PATCH'){deletes.push('PATCH');return {ok:false,status:405,json:async()=>({error:'method not allowed'})};}
   if(opts.method==='DELETE'){cacheDelete(key);deletes.push('unsafe DELETE');return response({ok:true});}
   return response(cacheGet(key));
  };
  const cache=new Cache();await cache.getOrCreate(key,async()=>[]);
  cacheSet(key,[{url:'new'}],60000);cache.noteFailure(key);await turn();await turn();
  console.log(JSON.stringify({current:cacheGet(key),deletes}));
 `);
 expect(r.current.streams).toEqual([{url:'new'}]);expect(r.deletes).toEqual(['PATCH']);
});

test('pruning during publication retracts the late result without resurrecting the match',()=>{
 const r=scenario(`
  let release,publishing=false;
  const {cachePrune}=await import('./resolver/src/cache.js');
  global.fetch=async(raw,opts={})=>{
   const u=new URL(raw);
   if(u.pathname==='/api/cache/prune')return response(cachePrune(JSON.parse(opts.body).activeIds));
   if(u.searchParams.get('claim')==='1')return response(cacheClaim(key,30000,true));
   if(opts.method==='POST'){publishing=true;await new Promise(r=>release=r);const b=JSON.parse(opts.body);return response(cacheSet(key,b.streams,b.ttlMs,b.status,b.ownerToken));}
   if(opts.method==='PATCH'){deletes.push(u.searchParams.get('revision'));return response(cacheDelete(key,undefined,u.searchParams.get('revision')));}
   return response(cacheGet(key));
  };
  const cache=new Cache(),pending=cache.getOrCreate(key,async()=>[{url:'late'}]);
  while(!publishing)await turn();cache.pruneEnded([]);release();await pending;await turn();
  console.log(JSON.stringify({current:cacheGet(key),local:cache.get(key),deletes}));
 `);
 expect(r.current.status).toBe('miss');expect(r.local).toBeNull();expect(r.deletes).toHaveLength(1);
});

test('publication completion after local eviction preserves the shared result',()=>{
 const r=scenario(`
  let release,publishing=false;
  global.fetch=async(raw,opts={})=>{
   const u=new URL(raw);
   if(u.searchParams.get('claim')==='1')return response(cacheClaim(key,30000,true));
   if(opts.method==='POST'){publishing=true;await new Promise(r=>release=r);const b=JSON.parse(opts.body);return response(cacheSet(key,b.streams,b.ttlMs,b.status,b.ownerToken));}
   if(opts.method==='PATCH'){deletes.push('PATCH');return response(cacheDelete(key,undefined,u.searchParams.get('revision')));}
   if(opts.method==='DELETE'){deletes.push('DELETE');return response(cacheDelete(key));}
   return response(cacheGet(key));
  };
  const cache=new Cache({maxEntries:1}),pending=cache.getOrCreate(key,async()=>[{url:'minted'}]);
  while(!publishing)await turn();
  cache._set('other:match:source','other','match',[{url:'other'}],'ok',60000);
  release();await pending;await turn();
  console.log(JSON.stringify({current:cacheGet(key),local:cache.get(key),stats:cache.stats(),deletes}));
 `);
 expect(r.current.streams).toEqual([{url:'minted'}]);expect(r.local).toBeNull();expect(r.stats.entries).toBe(1);expect(r.deletes).toEqual([]);
});

test('actual cache router handles conditional PATCH and requires a matching revision',()=>{
 const r=scenario(`
  const {readFileSync}=await import('node:fs');
  const {SourceTextModule,SyntheticModule,createContext}=await import('node:vm');
  const context=createContext({URL,Buffer,process:{env:{},uptime:()=>0},console});
  const mod=new SourceTextModule(readFileSync('./resolver/src/http/router.js','utf8'),{context});
  const cacheModule=await import('./resolver/src/cache.js');
  await mod.link(async name=>{
   const names=name==='../cache.js'?['cacheGet','cacheClaim','cacheSet','cacheDelete','cachePrune','cacheStats']:name==='../resolve/run.js'?['run']:['serveStatic'];
   return new SyntheticModule(names,function(){for(const n of names)this.setExport(n,name==='../cache.js'?cacheModule[n]:()=>{throw Error('Unexpected route fallback');});},{context});
  });await mod.evaluate();
  async function patch(revision){let result;await mod.namespace.route({method:'PATCH',url:'/api/cache/'+encodeURIComponent(key)+(revision===undefined?'':'?revision='+encodeURIComponent(revision)),headers:{host:'resolver.example'}},{writeHead(){},end(body){result=JSON.parse(body);}});return result;}
  const old=cacheSet(key,[{url:'old'}],60000);const missing=await patch();const wrong=await patch('wrong');
  const accepted=await patch(old.revision);console.log(JSON.stringify({missing,wrong,accepted,current:cacheGet(key)}));
 `);
 expect(r.missing.ok).toBe(false);expect(r.wrong.ok).toBe(false);expect(r.accepted.ok).toBe(true);expect(r.current.status).toBe('miss');
});
