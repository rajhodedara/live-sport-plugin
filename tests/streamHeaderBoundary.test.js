jest.mock('../src/container',()=>{const Registry=jest.requireActual('../src/services/IframeDomainRegistry');const registry=new Registry();return {resolve:name=>name==='iframeDomainRegistry'?registry:undefined};});
jest.mock('../src/impitClient',()=>({safeFetch:jest.fn(),isImpitAvailable:()=>false,getImpit:()=>null}));
const {safeFetch}=require('../src/impitClient');
const {verifyStreams}=require('../src/streams');
const {fetchUpstreamManifest}=require('../src/manifestProxy');
const M3U8ParserService=require('../src/services/M3U8ParserService');
const body='#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:5,\nsegment.ts\n';
const cache={noteSuccess(){},noteFailure(){}};
beforeEach(()=>safeFetch.mockReset());
test('saved repaired proxy query also lets the real manifest fetch helper succeed',async()=>{
 const upstream='https://c2807p.7odxv0l067ka.net/live.m3u8';
 safeFetch.mockImplementation(async(_,o)=>{const ok=o.headers.Referer==='https://assetrage.net/'&&o.headers.Origin==='https://assetrage.net';return {ok,status:ok?200:403,text:async()=>ok?body:'denied'}});
 const s={url:'https://addon.example/api/manifest?'+new URLSearchParams({url:upstream,referer:'https://wrong.example/',origin:'https://wrong.example'})};
 const [out]=await verifyStreams([s],'p:m:s',new M3U8ParserService(),cache,{skipSpeedProbe:true});
 const q=new URL(out.url).searchParams;await expect(fetchUpstreamManifest(q.get('url'),q.get('referer'),q.get('origin'))).resolves.toBe(body);
});
test('scope control: Authorization can verify directly while the current proxy helper still refuses',async()=>{
 safeFetch.mockImplementation(async(_,o)=>{const ok=o.headers.Authorization==='Bearer audit';return {ok,status:ok?200:403,text:async()=>ok?body:'denied'}});
 const s={url:'https://media.example/live.m3u8',behaviorHints:{proxyHeaders:{request:{Authorization:'Bearer audit',Referer:'https://ref.example/',Origin:'https://ref.example'}}}};
 const out=await verifyStreams([s],'p:m:s',new M3U8ParserService(),cache,{skipSpeedProbe:true});expect(out).toHaveLength(1);
 await expect(fetchUpstreamManifest(s.url,'https://ref.example/','https://ref.example')).rejects.toThrow('HTTP 403');
 expect(safeFetch.mock.calls.at(-1)[1].headers.Authorization).toBeUndefined();
});
