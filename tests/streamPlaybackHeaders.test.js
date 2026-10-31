jest.mock('../src/services/OutboundUrlGuard', () => ({ checkOutboundUrl: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/container',()=>{const Registry=jest.requireActual('../src/services/IframeDomainRegistry');const registry=new Registry();return {resolve:name=>name==='iframeDomainRegistry'?registry:undefined};});
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: (...args) => require('../src/impitClient').safeFetch(...args), streamingFetch: (...args) => global.fetch(...args) }));
jest.mock('../src/impitClient',()=>({safeFetch:jest.fn(),isImpitAvailable:()=>false,getImpit:()=>null}));
const {safeFetch}=require('../src/impitClient');
process.env.ENABLE_SPEED_PROBE = 'true';
const {verifyStreams}=require('../src/streams');
delete process.env.ENABLE_SPEED_PROBE;
const M3U8ParserService=require('../src/services/M3U8ParserService');
const parser=new M3U8ParserService();
const good='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\nsegment.ts\n';
const res=(status,body=good)=>({status,text:async()=>body});
const wrong='https://wrong.example/page',right='https://assetrage.net/';
const target='https://c2807p.7odxv0l067ka.net/live.m3u8?token=a%2Bb%26c';
function stream(headers={},proxy=false){return {url:proxy?'https://addon.example/api/manifest?'+new URLSearchParams({url:target,referer:wrong,origin:'https://wrong.example',rck:'provider:m:s',other:'a&b'})+'#keep':target,behaviorHints:{bingeGroup:'untouched',proxyHeaders:{response:{'X-Response':'keep'},request:headers}}};}
const cache=()=>({noteSuccess:jest.fn(),noteFailure:jest.fn()});
const run=s=>verifyStreams([s],'provider:m:s',parser,cache(),{skipSpeedProbe:true});
beforeEach(()=>safeFetch.mockReset());
test('default UA remains available when provider supplies no request hints',async()=>{
 safeFetch.mockResolvedValue(res(200));expect(await run({url:target})).toHaveLength(1);
 expect(safeFetch.mock.calls[0][1].headers['User-Agent']).toContain('Mozilla/5.0');
});
test('successful first verification does not rewrite playback URL or hints',async()=>{
 safeFetch.mockResolvedValue(res(200));const s=stream({Referer:wrong,Origin:'https://explicit.example'},true),before=s.url,hints=s.behaviorHints;
 expect(await run(s)).toEqual([s]);expect(s.url).toBe(before);expect(s.behaviorHints).toBe(hints);
});
test('known duplicate names are canonicalized with the last supplied value',async()=>{
 safeFetch.mockResolvedValue(res(200));const input=Object.freeze({Referer:wrong,referer:'https://last.example/',Authorization:'old',authorization:'Bearer FAKE'});
 expect(await run(stream(input))).toHaveLength(1);const sent=safeFetch.mock.calls[0][1].headers;
 expect(sent.Referer).toBe('https://last.example/');expect(sent.Authorization).toBe('Bearer FAKE');
 expect(Object.keys(sent).filter(k=>k.toLowerCase()==='authorization')).toEqual(['Authorization']);expect(input.Authorization).toBe('old');
});
test('custom names matching Object prototype fields remain ordinary own headers',async()=>{
 safeFetch.mockResolvedValue(res(200));const input=JSON.parse('{"Referer":"https://ref.example/","constructor":"fixture","__proto__":"literal"}');
 expect(await run(stream(input))).toHaveLength(1);const sent=safeFetch.mock.calls[0][1].headers;
 expect(Object.hasOwn(sent,'constructor')).toBe(true);expect(sent.constructor).toBe('fixture');expect(Object.hasOwn(sent,'__proto__')).toBe(true);expect(sent.__proto__).toBe('literal');
});
test('accepted repair preserves credential hints without embedding them in proxy query',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));
 const [out]=await run(stream({Referer:wrong,Authorization:'Bearer FAKE',Cookie:'session=FAKE'},true));
 const q=new URL(out.url).searchParams;expect([...q.keys()].sort()).toEqual(['origin','other','rck','referer','url']);
 expect(out.url).not.toContain('FAKE');expect(out.behaviorHints.proxyHeaders.request.Authorization).toBe('Bearer FAKE');
});
test('provider Authorization Cookie UA Origin and custom headers reach verification',async()=>{
 const h={Authorization:'Bearer audit',Cookie:'session=audit','User-Agent':'Provider-UA',Referer:wrong,Origin:'https://explicit-origin.example','X-Playback-Key':'custom'};
 safeFetch.mockImplementation(async(_,o)=>res(Object.keys(h).every(k=>o.headers[k]===h[k])?200:403));
 expect(await run(stream(h))).toHaveLength(1);expect(safeFetch.mock.calls[0][1].headers).toEqual(h);
});
test('known headers are read case-insensitively without duplicate spellings',async()=>{
 const h={authorization:'Bearer audit',cookie:'session=audit','user-agent':'Provider-UA',referer:wrong,origin:'https://explicit-origin.example'};
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Authorization==='Bearer audit'&&o.headers.Origin===h.origin?200:403));
 expect(await run(stream(h))).toHaveLength(1);
 const sent=safeFetch.mock.calls[0][1].headers;expect(sent['User-Agent']).toBe(h['user-agent']);expect(Object.keys(sent).filter(k=>k.toLowerCase()==='referer')).toEqual(['Referer']);
});
test('proxy query Referer and Origin take precedence over contradictory hints',async()=>{
 safeFetch.mockResolvedValue(res(200));const s=stream({Referer:'https://hint.example/',Origin:'https://hint.example',Authorization:'Bearer audit'},true);
 expect(await run(s)).toHaveLength(1);expect(safeFetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({Referer:wrong,Origin:'https://wrong.example',Authorization:'Bearer audit'}));
});
test('repair keeps Authorization Cookie UA and custom header on the second request',async()=>{
 const h={Referer:wrong,Authorization:'Bearer audit',Cookie:'session=audit','User-Agent':'Provider-UA','X-Playback-Key':'custom'};
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right&&o.headers.Authorization===h.Authorization&&o.headers.Cookie===h.Cookie?200:403));
 expect(await run(stream(h,true))).toHaveLength(1);expect(safeFetch).toHaveBeenCalledTimes(2);
 expect(safeFetch.mock.calls[1][1].headers).toEqual(expect.objectContaining({...h,Referer:right,Origin:'https://assetrage.net'}));
});
test('repair updates outer proxy query while preserving nested token rck other query and fragment',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));const s=stream({Referer:wrong},true);const before=new URL(s.url);const [out]=await run(s);const after=new URL(out.url);
 expect(after.searchParams.get('referer')).toBe(right);expect(after.searchParams.get('origin')).toBe('https://assetrage.net');
 for(const k of ['url','rck','other'])expect(after.searchParams.get(k)).toBe(before.searchParams.get(k));expect(after.hash).toBe('#keep');
});
test('direct repair persists hints and leaves upstream token URL unchanged',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));const s=stream({Referer:wrong});const before=s.url;const [out]=await run(s);
 expect(out.url).toBe(before);expect(out.behaviorHints.proxyHeaders.request).toEqual(expect.objectContaining({Referer:right,Origin:'https://assetrage.net'}));
});
test('repair creates playback hints when provider supplied none',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));const s={url:target};const [out]=await run(s);
 expect(out.behaviorHints.proxyHeaders.request).toEqual(expect.objectContaining({Referer:right,Origin:'https://assetrage.net'}));
});
test('refused repair does not publish a guessed Referer into original hints or URL',async()=>{
 safeFetch.mockResolvedValue(res(403));const s=stream({Referer:wrong},true);const before=JSON.stringify(s);expect(await run(s)).toEqual([]);expect(JSON.stringify(s)).toBe(before);
});
test('200 repair with invalid body is dropped before changing playback hints',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403,'not a playlist'));const s=stream({Referer:wrong},true);const before=JSON.stringify(s);
 expect(await run(s)).toEqual([]);expect(JSON.stringify(s)).toBe(before);
});
test('repair preserves stream identity and response hints without modifying shared header objects',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));const headers={Referer:wrong,Origin:'https://wrong.example',Authorization:'Bearer audit'};const s=stream(headers,true);const oldHints=s.behaviorHints,oldProxy=oldHints.proxyHeaders;
 const [out]=await run(s);expect(out).toBe(s);expect(headers.Referer).toBe(wrong);expect(oldProxy.request).toBe(headers);expect(out.behaviorHints.proxyHeaders.request).not.toBe(headers);expect(out.behaviorHints.proxyHeaders.response).toEqual({'X-Response':'keep'});expect(out.behaviorHints.bingeGroup).toBe('untouched');
});
test('relative manifest proxy keeps a relative URL after repair',async()=>{
 safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));const s=stream({Referer:wrong},true);s.url=s.url.replace('https://addon.example','');const [out]=await run(s);
 expect(out.url.startsWith('/api/manifest?')).toBe(true);expect(new URL(out.url,'https://addon.example').searchParams.get('referer')).toBe(right);
});
test('registry Referer with a path uses its origin for repair and playback hints',async()=>{
 const registry=require('../src/container').resolve('iframeDomainRegistry');const host='audit-registry-path.example',ref='https://registry.example/embed/player';registry.terminalHosts.set(host,{referer:ref});
 try{
  safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===ref?200:403));const s={url:'https://'+host+'/live.m3u8',behaviorHints:{proxyHeaders:{request:{Referer:wrong}}}};
  const [out]=await run(s);expect(safeFetch.mock.calls[1][1].headers.Origin).toBe('https://registry.example');expect(out.behaviorHints.proxyHeaders.request.Origin).toBe('https://registry.example');
 }finally{registry.terminalHosts.delete(host)}
});
test('speed probe uses the accepted repaired Referer and Origin',async()=>{
 const oldFetch=global.fetch;global.fetch=jest.fn(async()=>({ok:false}));
 try{
  safeFetch.mockImplementation(async(_,o)=>res(o.headers.Referer===right?200:403));const s=stream({Referer:wrong},true);
  const out=await verifyStreams([s],'provider:m:s',parser,cache());expect(out).toHaveLength(1);expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining({Referer:right,Origin:'https://assetrage.net'}));
 }finally{global.fetch=oldFetch}
});
