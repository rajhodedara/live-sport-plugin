// Real loopback HTTP, Express and undici fallback; no public provider requests.
const http=require('node:http');
const net=require('node:net');
jest.mock('../src/container',()=>({resolve:jest.fn()}));
jest.mock('../src/streams',()=>({resolveSource:jest.fn()}));
jest.mock('impit',()=>{throw new Error('test: native impit disabled');},{virtual:true});
jest.mock('undici',()=>{
  const actual=jest.requireActual('undici');const agents=[];
  return {...actual,_testAgents:agents,Agent:class extends actual.Agent{
    constructor(...args){super(...args);agents.push(this);}
  }};
});
const express=require('express');
const undici=require('undici');
const container=require('../src/container');
const {resolveSource}=require('../src/streams');
const {safeFetch}=require('../src/impitClient');
const proxy=require('../src/manifestProxy');
const remint=require('../src/remint');
const router=require('../src/routes/manifest');
const servers=[],ports=new Set(),seen=[],longTimers=[];
const connect=net.Socket.prototype.connect;let upstream,mirror,addon,client,timerSpy;
const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8\n';
const media='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment.ts\n';
async function listen(fn){const s=http.createServer(fn);servers.push(s);await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});ports.add(s.address().port);return 'http://127.0.0.1:'+s.address().port;}
beforeAll(async()=>{
  net.Socket.prototype.connect=function(...args){const a=Array.isArray(args[0])?args[0][0]:args[0];if(typeof a!=='object'||a.host!=='127.0.0.1'||!ports.has(Number(a.port)))throw new Error('TEST_NETWORK_BLOCKED');return connect.apply(this,args);};
  const nativeTimeout=global.setTimeout;
  timerSpy=jest.spyOn(global,'setTimeout').mockImplementation((fn,ms,...rest)=>{const t=nativeTimeout(fn,ms,...rest);if(ms===remint.REMINT_TIMEOUT_MS)longTimers.push(t);return t;});
  mirror=await listen((req,res)=>{seen.push('mirror'+req.url);res.end(media);});
  upstream=await listen((req,res)=>{
    seen.push(req.url);const p=req.url.split('?')[0];
    const redirect=to=>{res.writeHead(302,{location:to});res.end();};
    if(p==='/redirect-master')return redirect('/final/master.m3u8?fresh=2');
    if(p==='/redirect-media')return redirect('/final/media.m3u8?fresh=2');
    if(p==='/cross')return redirect(mirror+'/mirror/media.m3u8?fresh=2');
    if(p==='/chain')return redirect('/redirect-media');
    if(p==='/flaky'&&seen.filter(x=>x==='/flaky').length===1){res.writeHead(503);res.end('temporary');return;}
    if(p==='/flaky')return redirect('/final/media.m3u8?fresh=2');
    if(p==='/expired/master.m3u8'){res.writeHead(403);res.end('expired');return;}
    if(p==='/minted/master.m3u8')return redirect('/final/master.m3u8?fresh=2');
    if(p==='/final/master.m3u8'){res.end(master);return;}
    if(p==='/child.m3u8'){res.writeHead(404);res.end('wrong directory');return;}
    res.end(media);
  });
  const app=express();app.use(router);addon=await listen(app);client=new undici.Agent();
});
beforeEach(()=>{
  seen.length=0;proxy.manifestCache.clear();proxy.manifestInFlight.clear();remint.remintCache.clear();
  container.resolve.mockImplementation(name=>name==='cacheService'?{getMatches:()=>[{id:'match',sources:[{id:'source',source:'embedst'}]}]}:{noteFailure:jest.fn()});
  resolveSource.mockReset();resolveSource.mockResolvedValue([{url:upstream+'/minted/master.m3u8'}]);
});
afterEach(()=>{for(const t of longTimers.splice(0))clearTimeout(t);expect(proxy.manifestInFlight.size).toBe(0);});
afterAll(async()=>{timerSpy.mockRestore();for(const t of longTimers)clearTimeout(t);await Promise.all(undici._testAgents.map(a=>a.destroy()));await Promise.all(servers.map(s=>new Promise(r=>{s.closeAllConnections();s.close(r);})));net.Socket.prototype.connect=connect;expect(servers.every(s=>!s.listening)).toBe(true);});
async function get(url){const r=await undici.request(url,{dispatcher:client,headersTimeout:3000,bodyTimeout:3000});return {status:r.statusCode,headers:r.headers,body:await r.body.text()};}
const route=(target,params={})=>addon+'/api/manifest?'+new URLSearchParams({url:target,...params});
const child=(res)=>res.body.split('\n').find(x=>x.startsWith('/api/manifest?'));
test('safeFetch exposes URL for direct response',async()=>expect((await safeFetch(upstream+'/direct')).url).toBe(upstream+'/direct'));
test('safeFetch exposes final URL after relative redirect',async()=>expect((await safeFetch(upstream+'/redirect-media?old=1')).url).toBe(upstream+'/final/media.m3u8?fresh=2'));
test('safeFetch exposes final URL through two hops',async()=>expect((await safeFetch(upstream+'/chain')).url).toBe(upstream+'/final/media.m3u8?fresh=2'));
test('safeFetch exposes final URL when origin port changes',async()=>expect((await safeFetch(upstream+'/cross')).url).toBe(mirror+'/mirror/media.m3u8?fresh=2'));
test('manifest fetch default API still returns a string',async()=>expect(await proxy.fetchUpstreamManifest(upstream+'/redirect-media','https://embed.example/','https://embed.example')).toBe(media));
test('manifest fetch opt-in metadata carries final URL and body',async()=>{
  const r=await proxy.fetchUpstreamManifest(upstream+'/redirect-media','https://embed.example/','https://embed.example',{withResponseUrl:true});
  expect(r).toEqual({body:media,url:upstream+'/final/media.m3u8?fresh=2'});
});
test('redirected media segment uses final directory and query',async()=>{
  const r=await get(route(upstream+'/redirect-media?old=1'));expect(r.status).toBe(200);
  const segment=r.body.split('\n').find(x=>x.startsWith(upstream));expect(segment).toBe(upstream+'/final/segment.ts?fresh=2');
});
test('redirected master resolves child at final directory',async()=>{
  const r=await get(route(upstream+'/redirect-master'));expect(new URL(addon+child(r)).searchParams.get('url')).toBe(upstream+'/final/child.m3u8?fresh=2');
});
test('following rewritten redirected child produces HTTP 200',async()=>{
  const r=await get(route(upstream+'/redirect-master'));expect((await get(addon+child(r))).status).toBe(200);
});
test('redirected KEY and MAP resolve at final directory',async()=>{
  const r=await get(route(upstream+'/redirect-media'));expect(r.body).toContain('URI="'+upstream+'/final/keys/key.bin"');expect(r.body).toContain('URI="'+upstream+'/final/init.mp4"');
});
test('redirected cross-origin segment uses mirror directory and token',async()=>{
  const r=await get(route(upstream+'/cross'));expect(r.body).toContain(mirror+'/mirror/segment.ts?fresh=2');
});
test('503 retry preserves final response metadata',async()=>{
  const r=await proxy.fetchUpstreamManifest(upstream+'/flaky','','',{withResponseUrl:true});expect(r).toEqual({body:media,url:upstream+'/final/media.m3u8?fresh=2'});expect(seen.filter(x=>x==='/flaky')).toHaveLength(2);
});
test('remint followed by redirect uses final playlist base',async()=>{
  const r=await get(route(upstream+'/expired/master.m3u8',{rck:'embedst:match:source'}));expect(r.status).toBe(200);expect(resolveSource).toHaveBeenCalledTimes(1);
  const u=new URL(addon+child(r));expect(u.searchParams.get('url')).toBe(upstream+'/final/child.m3u8?fresh=2');expect(u.searchParams.get('rck')).toBe('embedst:match:source');
});
test('redirected master cache HIT preserves final-base body',async()=>{
  const target=route(upstream+'/redirect-master');const first=await get(target);const next=await get(target);expect(next.headers['x-manifest-cache']).toBe('HIT');expect(next.body).toBe(first.body);expect(new URL(addon+child(next)).searchParams.get('url')).toBe(upstream+'/final/child.m3u8?fresh=2');expect(seen.filter(x=>x==='/redirect-master')).toHaveLength(1);
});
