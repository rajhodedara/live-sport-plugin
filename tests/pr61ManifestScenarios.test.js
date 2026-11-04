'use strict';
// Actual manifest route, cache and HLS rewriter with simulated upstream I/O.
jest.mock('express', () => ({ Router: () => ({get:jest.fn(),use:jest.fn(),options:jest.fn(),all:jest.fn()}),json:()=>()=>{},urlencoded:()=>()=>{} }));
jest.mock('../src/container', () => ({resolve:()=>({noteFailure:jest.fn()})}));
jest.mock('../src/impitClient', () => ({safeFetch:jest.fn()}));
jest.mock('../src/config', () => ({getRequestBaseUrl:req=>req.base||'https://addon.example.test'}));
const {safeFetch}=require('../src/impitClient');
const proxy=require('../src/manifestProxy');
const router=require('../src/routes/manifest');
const handler=router.get.mock.calls.find(([routes])=>Array.isArray(routes)&&routes.includes('/api/manifest'))[1];
const upstream='https://cdn.example.test/live/master.m3u8?token=synthetic';
const master='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nchild.m3u8\n';
function res(){return {code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.code=c;return this;},send(body){this.body=body;return this;}};}
async function render(query={},base){const out=res();await handler({query:{url:upstream,referer:'https://provider.example.test/',origin:'https://provider.example.test',...query},base,url:'/api/manifest'},out);return out;}
beforeEach(()=>{proxy.manifestCache.clear();proxy.manifestInFlight.clear();safeFetch.mockReset();safeFetch.mockResolvedValue({ok:true,status:200,url:upstream,text:async()=>master});});

test('custom UA reaches parent fetch and child URL; caches isolate UA and addon host',async()=>{
 const a=await render({hlsua:'Client-A/1.0'});
 const again=await render({hlsua:'Client-A/1.0'});
 const b=await render({hlsua:'Client-B/1.0'});
 const otherHost=await render({hlsua:'Client-A/1.0'},'https://other-addon.example.test');
 expect(a.code).toBe(200);expect(again.headers['X-Manifest-Cache']).toBe('HIT');expect(safeFetch).toHaveBeenCalledTimes(3);
 const child=new URL(a.body.split('\n').find(line=>line.startsWith('https://')));
 expect(child.searchParams.get('hlsua')).toBe('Client-A/1.0');
 expect(new URL(child.searchParams.get('url')).pathname).toBe('/live/child.m3u8');
 expect(child.searchParams.get('referer')).toBe('https://provider.example.test/');
 expect(safeFetch.mock.calls.map(([,opts])=>opts.headers['User-Agent'])).toEqual(['Client-A/1.0','Client-B/1.0','Client-A/1.0']);
 expect(b.body).toContain('Client-B%2F1.0');expect(otherHost.body).toContain('https://other-addon.example.test/');
 for(const [,opts] of safeFetch.mock.calls)expect(opts).toMatchObject({guardExternal:true,diagnosticOwner:'manifest'});
});

test('child playlist resolves relative media against the effective redirect URL',async()=>{
 safeFetch.mockResolvedValue({ok:true,status:200,url:'https://edge.example.test/new/child.m3u8?token=fresh',text:async()=>'#EXTM3U\n#EXTINF:6,\nsegment.ts\n'});
 const out=await render({hlsua:'Client-A/1.0'});
 expect(out.code).toBe(200);expect(out.body).toContain('https://edge.example.test/new/segment.ts');
 expect(out.headers['X-Manifest-Cache']).toBe('BYPASS');
});

test('upstream refusal remains a failed stream and repeat request uses the short negative cache',async()=>{
 const log=jest.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  safeFetch.mockResolvedValue({ok:false,status:403});
  const a=await render();const b=await render();
  expect(a.code).toBe(404);expect(b.code).toBe(404);expect(b.headers['X-Manifest-Cache']).toBe('NEGATIVE');
  expect(safeFetch).toHaveBeenCalledTimes(1);
 }finally{log.mockRestore();}
});

test('local capacity returns 503 without poisoning the manifest cache',async()=>{
 const log=jest.spyOn(console,'warn').mockImplementation(()=>{});
 try{
  safeFetch.mockRejectedValueOnce(Object.assign(new Error('fixture capacity'),{code:'ERR_OUTBOUND_CAPACITY'}));
  const first=await render();const next=await render();
  expect(first.code).toBe(503);expect(first.headers['Cache-Control']).toBe('no-store');expect(next.code).toBe(200);expect(safeFetch).toHaveBeenCalledTimes(2);
 }finally{log.mockRestore();}
});
