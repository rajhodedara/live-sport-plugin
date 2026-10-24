/** LSP-114: real Express router + loopback HTTP + real undici fallback.
 * Container/provider resolution are mocked; no full addon is started.
 */
const http = require('node:http');
const net = require('node:net');
jest.mock('../src/container', () => ({resolve:jest.fn()}));
jest.mock('../src/streams', () => ({resolveSource:jest.fn()}));
jest.mock('impit', () => {throw new Error('test: native impit disabled');}, {virtual:true});
jest.mock('undici', () => {
  const actual=jest.requireActual('undici');
  const agents=[];
  return {...actual,_testAgents:agents,Agent:class extends actual.Agent {
    constructor(...args){super(...args);agents.push(this);}
  }};
});
const express=require('express');
const undici=require('undici');
const container=require('../src/container');
const {resolveSource}=require('../src/streams');
const proxy=require('../src/manifestProxy');
const remint=require('../src/remint');
const router=require('../src/routes/manifest');
const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8\n';
const media='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const originalConnect=net.Socket.prototype.connect;
const ports=new Set(),servers=[],gates=new Map(),events=[],clientRequests=[],longTimers=[];
let upstream,addon,client,matches,timeoutSpy;
async function listen(handler){
  const s=http.createServer(handler);servers.push(s);
  await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});
  ports.add(s.address().port);return 'http://127.0.0.1:'+s.address().port;
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function url(target,rck,query={}){return addon+'/api/manifest?'+new URLSearchParams({url:target,...(rck===undefined?{}:{rck}),...query});}
async function request(target,rck,query={}){
  const res=await undici.request(url(target,rck,query),{dispatcher:client,headersTimeout:3000,bodyTimeout:3000});
  return {status:res.statusCode,headers:res.headers,body:await res.body.text()};
}
function identity(res){const line=res.body.split('\n').find(x=>x.startsWith('/api/manifest?'));return new URL(addon+line).searchParams.get('rck');}
function count(prefix){return events.filter(p=>p.startsWith(prefix)).length;}
async function concurrent(path,keys){
  let release;let jobs=[];gates.set(path,new Promise(r=>release=r));
  try{
    jobs=keys.map(key=>request(upstream+path,key));
    const deadline=Date.now()+2000;
    while((clientRequests.length<keys.length || events.length===0) && Date.now()<deadline)await pause(5);
    expect(clientRequests).toHaveLength(keys.length);
    expect(events.length).toBeGreaterThan(0);
    release();return await Promise.all(jobs);
  }finally{release();await Promise.allSettled(jobs);gates.delete(path);}
}
beforeAll(async()=>{
  net.Socket.prototype.connect=function(...args){
    const a=Array.isArray(args[0])?args[0][0]:args[0];
    if(typeof a!=='object'||a.host!=='127.0.0.1'||!ports.has(Number(a.port)))throw new Error('TEST_NETWORK_BLOCKED');
    return originalConnect.apply(this,args);
  };
  // Cleanup seam, not a fix for production remint timer retention (LSP-113).
  const nativeTimeout=global.setTimeout;
  timeoutSpy=jest.spyOn(global,'setTimeout').mockImplementation((fn,ms,...rest)=>{
    const t=nativeTimeout(fn,ms,...rest);if(ms===remint.REMINT_TIMEOUT_MS)longTimers.push(t);return t;
  });
  upstream=await listen(async(req,res)=>{
    events.push(req.url);const path=req.url.split('?')[0];
    if(gates.has(path))await gates.get(path);
    if(path==='/old/master.m3u8'){res.writeHead(403);res.end('expired');return;}
    if(path==='/bad'){res.end('<html>not HLS</html>');return;}
    res.end(path.endsWith('master.m3u8')?master:media);
  });
  const app=express();app.use((req,res,next)=>{clientRequests.push(req.originalUrl);next();});app.use(router);addon=await listen(app);
  client=new undici.Agent();
});
beforeEach(()=>{
  proxy.manifestCache.clear();proxy.manifestInFlight.clear();remint.remintCache.clear();events.length=0;clientRequests.length=0;
  matches=[{id:'match',sources:[{id:'source',source:'embedst'}]}, {id:'match-B',sources:[{id:'source-B',source:'embedst'}]}];
  container.resolve.mockImplementation(name=>{
    if(name==='cacheService')return {getMatches:()=>matches};
    if(name==='streamResolveCache')return {noteFailure:jest.fn()};
    throw new Error('Unexpected service '+name);
  });
  resolveSource.mockReset();resolveSource.mockImplementation(async(_src,match)=>{
    await pause(30);return [{url:upstream+(match.id==='match'?'/fresh-A/master.m3u8':'/fresh-B/master.m3u8')}];
  });
});
afterEach(()=>{for(const t of longTimers.splice(0))clearTimeout(t);expect(proxy.manifestInFlight.size).toBe(0);});
afterAll(async()=>{
  timeoutSpy?.mockRestore();for(const t of longTimers)clearTimeout(t);
  await Promise.all(undici._testAgents.map(a=>a.destroy()));
  await Promise.all(servers.map(s=>new Promise(r=>{s.closeAllConnections();s.close(r);})));
  net.Socket.prototype.connect=originalConnect;
  expect(servers.every(s=>!s.listening)).toBe(true);
});

test('negative result without rck must not block valid keyed recovery',async()=>{
  expect((await request(upstream+'/old/master.m3u8')).status).toBe(404);
  const r=await request(upstream+'/old/master.m3u8','embedst:match:source');
  expect(r.status).toBe(200);expect(identity(r)).toBe('embedst:match:source');expect(resolveSource).toHaveBeenCalledTimes(1);
});
test('cached master preserves each caller rck',async()=>{
  await request(upstream+'/master.m3u8','A');const b=await request(upstream+'/master.m3u8','B');expect(identity(b)).toBe('B');
});
test('parallel master callers preserve distinct identities',async()=>{
  const [a,b]=await concurrent('/parallel/master.m3u8',['A','B']);expect(identity(a)).toBe('A');expect(identity(b)).toBe('B');
});
test('unkeyed caller does not inherit previous rck',async()=>{
  await request(upstream+'/master.m3u8','A');expect(identity(await request(upstream+'/master.m3u8'))).toBeNull();
});
test('distinct valid contexts remint their own upstream paths',async()=>{
  const [a,b]=await concurrent('/old/master.m3u8',['embedst:match:source','embedst:match-B:source-B']);
  expect(a.status).toBe(200);expect(b.status).toBe(200);expect(a.body).toContain('fresh-A');expect(b.body).toContain('fresh-B');expect(resolveSource).toHaveBeenCalledTimes(2);
});
test('16 callers with same rck coalesce to one upstream request',async()=>{
  const all=await concurrent('/same/master.m3u8',Array(16).fill('same:match:source'));
  expect(all.every(r=>r.status===200&&identity(r)==='same:match:source')).toBe(true);expect(count('/same/master.m3u8')).toBe(1);
});
test('same rck positive HIT avoids refetch',async()=>{
  await request(upstream+'/master.m3u8','A');const r=await request(upstream+'/master.m3u8','A');expect(r.headers['x-manifest-cache']).toBe('HIT');expect(count('/master.m3u8')).toBe(1);
});
test('absent and empty rck are equivalent',async()=>{
  await request(upstream+'/master.m3u8');const r=await request(upstream+'/master.m3u8','');expect(r.headers['x-manifest-cache']).toBe('HIT');expect(identity(r)).toBeNull();
});
test('encoded Unicode recovery identity round trips',async()=>{
  const key='provider:match con espacios:fuente/ñ+?&';expect(identity(await request(upstream+'/master.m3u8',key))).toBe(key);
});
test('same rck negative HIT avoids refetch and remint',async()=>{
  resolveSource.mockResolvedValue([]);expect((await request(upstream+'/old/master.m3u8','embedst:match:source')).status).toBe(404);
  const r=await request(upstream+'/old/master.m3u8','embedst:match:source');expect(r.headers['x-manifest-cache']).toBe('NEGATIVE');expect(count('/old/master.m3u8')).toBe(1);expect(resolveSource).toHaveBeenCalledTimes(1);
});
test('same rck expired positive entry refetches',async()=>{
  await request(upstream+'/master.m3u8','A');for(const e of proxy.manifestCache.values())e.expiresAt=Date.now()-1000;
  expect((await request(upstream+'/master.m3u8','A')).headers['x-manifest-cache']).toBe('MISS');expect(count('/master.m3u8')).toBe(2);
});
test('same rck expired negative entry retries upstream',async()=>{
  expect((await request(upstream+'/bad','A')).status).toBe(404);for(const e of proxy.manifestCache.values())e.expiresAt=Date.now()-1000;
  expect((await request(upstream+'/bad','A')).status).toBe(404);expect(count('/bad')).toBe(2);
});
test('negative result for unknown match does not block another valid recovery context',async()=>{
  expect((await request(upstream+'/old/master.m3u8','embedst:missing:source')).status).toBe(404);
  const valid=await request(upstream+'/old/master.m3u8','embedst:match-B:source-B');
  expect(valid.status).toBe(200);expect(valid.body).toContain('fresh-B');expect(resolveSource).toHaveBeenCalledTimes(1);
});
test('16 same-identity failures coalesce upstream and failed remint',async()=>{
  resolveSource.mockResolvedValue([]);
  const all=await concurrent('/old/master.m3u8',Array(16).fill('embedst:match:source'));
  expect(all.every(r=>r.status===404)).toBe(true);expect(count('/old/master.m3u8')).toBe(1);expect(resolveSource).toHaveBeenCalledTimes(1);
});
test('same rck with distinct Origins keeps independent cache entries',async()=>{
  await request(upstream+'/master.m3u8','A',{origin:'https://one.invalid'});
  const other=await request(upstream+'/master.m3u8','A',{origin:'https://two.invalid'});
  expect(other.headers['x-manifest-cache']).toBe('MISS');expect(count('/master.m3u8')).toBe(2);
});
test('negative cache is independent for two invalid recovery identities',async()=>{
  const first=await request(upstream+'/old/master.m3u8','embedst:missing-A:source');
  const second=await request(upstream+'/old/master.m3u8','embedst:missing-B:source');
  expect(first.status).toBe(404);expect(second.status).toBe(404);
  expect(second.headers['x-manifest-cache']).not.toBe('NEGATIVE');expect(count('/old/master.m3u8')).toBe(2);
});
