/** Actual manifest handler and rewriter; no HTTP listener or network. */
jest.mock('express', () => ({ Router: () => ({ get: jest.fn(), use: jest.fn(), options: jest.fn(), all: jest.fn() }), json: () => () => {}, urlencoded: () => () => {} }));
jest.mock('../src/container',()=>({resolve:()=>({noteFailure:jest.fn()})}));
jest.mock('../src/impitClient',()=>({safeFetch:jest.fn()}));
const {safeFetch}=require('../src/impitClient');
const proxy=require('../src/manifestProxy');
const router=require('../src/routes/manifest');
const base='https://cdn.example/live/master.m3u8?parent=SECRET';
let body;
const addon='https://addon.example.test';
beforeEach(()=>{
  proxy.manifestCache.clear();proxy.manifestInFlight.clear();safeFetch.mockReset();
  safeFetch.mockImplementation(async()=>({ok:true,status:200,text:async()=>body}));
});
afterEach(()=>expect(proxy.manifestInFlight.size).toBe(0));
async function render(tag,params={}){
  body='#EXTM3U\n'+tag+'\n#EXTINF:6,\nsegment.ts\n';
  const req={query:{url:base,...params},headers:{host:'addon.example.test'},protocol:'https',url:'/api/manifest?'+new URLSearchParams({url:base,...params})};
  const result={status:200};
  const res={setHeader(){},status(code){result.status=code;return this;},send(body){result.body=body;return this;}};
  await router.get.mock.calls[0][1](req,res);
  return result;
}
// Consume whole attributes so URI= text inside a quoted NAME is not mistaken
// for the URI attribute being asserted.
function uriAttribute(line) {
  const attributes = line.slice(line.indexOf(':') + 1).matchAll(/(?:^|,)\s*([A-Z0-9-]+)=("[^"]*"|[^,]*)/g);
  for (const [, name, value] of attributes) if (name === 'URI') return value.replace(/^"|"$/g, '');
}
test.each([
 ['key','#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"','https://cdn.example/live/keys/key.bin',false],
 ['session key','#EXT-X-SESSION-KEY:METHOD=AES-128,URI="keys/key.bin"','https://cdn.example/live/keys/key.bin',false],
 ['audio','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/index.m3u8"','https://cdn.example/live/audio/index.m3u8',true],
 ['extensionless audio','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio/live"','https://cdn.example/live/audio/live',true],
 ['extensionless I-frame','#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe/live"','https://cdn.example/live/iframe/live',true],
 ['subtitles','#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subs/index.m3u8"','https://cdn.example/live/subs/index.m3u8',true],
 ['I-frame','#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1000,URI="iframe/index.m3u8"','https://cdn.example/live/iframe/index.m3u8',true],
 ['session data','#EXT-X-SESSION-DATA:DATA-ID="example",URI="data/info.json"','https://cdn.example/live/data/info.json',false],
 ['root-relative key','#EXT-X-KEY:METHOD=AES-128,URI="/keys/key.bin"','https://cdn.example/keys/key.bin',false],
 ['parent path key','#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin"','https://cdn.example/keys/key.bin',false],
 ['protocol-relative audio','#EXT-X-MEDIA:TYPE=AUDIO,URI="//audio.example/index.m3u8?own=1"','https://audio.example/index.m3u8?own=1',true],
 ['quoted comma/name','#EXT-X-MEDIA:TYPE=AUDIO,NAME="foo,URI=",URI="audio/index.m3u8"','https://cdn.example/live/audio/index.m3u8',true],
 ['LL-HLS part','#EXT-X-PART:DURATION=0.5,URI="part-1.m4s"','https://cdn.example/live/part-1.m4s?parent=SECRET',false],
 ['LL-HLS preload','#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-2.m4s"','https://cdn.example/live/part-2.m4s?parent=SECRET',false],
 ['rendition report','#EXT-X-RENDITION-REPORT:URI="other.m3u8?own=1"','https://cdn.example/live/other.m3u8?own=1',true],
 ['image stream playlist','#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=1000,URI="images.m3u8"','https://cdn.example/live/images.m3u8',true],
])('%s URI attribute resolves against upstream playlist',async(_name,tag,expected,isPlaylist)=>{
  const r=await render(tag);expect(r.status).toBe(200);
  if (isPlaylist) {
    const uri=r.body.split('\n').map(uriAttribute).find(x=>x && x.includes('/api/manifest?'));
    expect(uri).toBeTruthy();
    const proxied=new URL(uri,addon);
    expect(proxied.pathname).toBe('/api/manifest');
    const rawUri = uriAttribute(tag) || '';
    const isAbsoluteReference = /^[a-z][a-z\d+.-]*:/i.test(rawUri) || rawUri.startsWith('//');
    const expectedUrl = isAbsoluteReference
      ? expected
      : expected + (expected.includes('?') ? '&parent=SECRET' : '?parent=SECRET');
    expect(proxied.searchParams.get('url')).toBe(expectedUrl);
  } else {
    expect(r.body).toContain('URI="'+expected+'"');
  }
  if(tag.includes('NAME='))expect(r.body).toContain('NAME="foo,URI="');
});
test('MAP retains existing absolute resolution and explicit query',async()=>{
  const r=await render('#EXT-X-MAP:URI="init.mp4?own=1",BYTERANGE="10@0"');
  expect(r.body).toContain('URI="https://cdn.example/live/init.mp4?own=1",BYTERANGE="10@0"');
});
test.each([
 ['absolute key','#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key.bin?own=1"'],
 ['FairPlay key','#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license.example/key"'],
 ['data key','#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,YQ=="'],
 ['in-band rendition','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Main"'],
 ['empty URI','#EXT-X-KEY:METHOD=AES-128,URI=""'],
 ['unknown tag','#EXT-X-EXAMPLE:URI="relative/path"'],
 ['malformed URL','#EXT-X-KEY:METHOD=AES-128,URI="http://["'],
])('%s remains unchanged',async(_name,tag)=>expect((await render(tag)).body).toContain(tag));
test('key endpoint ending in m3u8 stays a direct key URL',async()=>{
  const r=await render('#EXT-X-KEY:METHOD=AES-128,URI="keys/key.m3u8"');
  expect(r.body).toContain('URI="https://cdn.example/live/keys/key.m3u8"');
  expect(r.body).not.toContain('/api/manifest?');
});
test('ordinary segment rewrite is unchanged',async()=>{
  const r=await render('#EXT-X-TARGETDURATION:6');expect(r.body).toContain('https://cdn.example/live/segment.ts?parent=SECRET');
});
test('user agent follows playlist attributes but is not appended to direct media or key URLs',async()=>{
  const r=await render('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin"',{hlsua:'FixtureClient/1.0'});
  const audio = new URL(r.body.match(/URI="([^"]*\/api\/manifest\?[^"]+)"/)[1], addon);
  expect(audio.searchParams.get('hlsua')).toBe('FixtureClient/1.0');
  expect(r.body).toContain('URI="https://cdn.example/live/keys/key.bin"');
  expect(r.body).toContain('https://cdn.example/live/segment.ts?parent=SECRET');
  expect(r.body).not.toContain('segment.ts?parent=SECRET&hlsua=');
});
test('ordinary master child preserves proxy headers and recovery key',async()=>{
  const r=await render('#EXT-X-STREAM-INF:BANDWIDTH=1000\nchild.m3u8',{referer:'https://embed.example/',origin:'https://embed.example',rck:'provider:match:source'});
  const line=r.body.split('\n').find(x=>x.includes('/api/manifest?'));const u=new URL(line,addon);
  expect(u.searchParams.get('referer')).toBe('https://embed.example/');expect(u.searchParams.get('origin')).toBe('https://embed.example');expect(u.searchParams.get('rck')).toBe('provider:match:source');
});
test('playlist URI attributes preserve referer, origin, and rck through proxy',async()=>{
  const r=await render('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"',{
    referer:'https://embed.example/',origin:'https://embed.example',rck:'provider:match:source'
  });
  const uri=r.body.match(/URI="([^"]+)"/)[1];
  const proxied=new URL(uri,addon);
  expect(proxied.searchParams.get('referer')).toBe('https://embed.example/');
  expect(proxied.searchParams.get('origin')).toBe('https://embed.example');
  expect(proxied.searchParams.get('rck')).toBe('provider:match:source');
  expect(proxied.searchParams.get('url')).toContain('/audio/index.m3u8');
});
test('tag resources do not inherit parent query tokens implicitly',async()=>{
  const r=await render('#EXT-X-MAP:URI="https://other.example/init.mp4?own=1"');
  expect(r.body).toContain('URI="https://other.example/init.mp4?own=1"');expect(r.body).not.toContain('URI="https://other.example/init.mp4?own=1&parent=SECRET"');
});
