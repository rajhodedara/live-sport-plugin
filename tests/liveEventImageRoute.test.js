const fs=require('fs'),path=require('path'),vm=require('vm');
const {generateMatchCardSvg}=require('../src/services/MinimalistPosterService');
const {usesLiveEventArtwork}=require('../src/services/LiveEventArtwork');
function fixture(){
  const source=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  const start=source.indexOf("app.get(['/img/match'");
  const end=source.indexOf('\n});',start)+4;
  let handler;
  const getImage=jest.fn(async()=>{throw new Error('unexpected artwork fetch');});
  const render=jest.fn(generateMatchCardSvg);
  const memo=new Map();
  const context={app:{get:(paths,fn)=>{handler=fn;}},Buffer,URL,Set,Map,console,
    imageService:{getImage,generateMatchCardSvg:render},usesLiveEventArtwork,matchCardMemo:memo,MATCH_CARD_MEMO_MAX:120,
    LOGO_BY_NAME:new Map(),LOGO_BY_NAME_MAX:2000,container:{resolve:()=>{throw new Error('fixture no provider');}},
    resolveEmbedBase:()=> 'https://addon.test',entryToDataUri:jest.fn(),require:()=>{throw new Error('fixture SVG fallback');}};
  vm.runInNewContext(source.slice(start,end),context);
  const request=async query=>{
    const res={headers:{},setHeader(k,v){this.headers[k]=v;},send(body){this.body=body;return this;}};
    await handler({query},res);return res;
  };
  return{request,render,getImage,memo};
}
const query={cat:'tennis',st:'upcoming',art:'event-v3',t1:'Kimberly Birrell',t2:'Katie Volynets',lg:'WTA',tm:'8:30 AM'};
test('actual image handler passes the opt-in and serves a memoized SVG without badge fetches',async()=>{
  const f=fixture(); const first=await f.request({...query,b1:'https://fixture.invalid/ignored.png'}); const second=await f.request({...query,b1:'https://fixture.invalid/ignored.png'});
  expect(first.body).toContain('live-event-v3');expect(first.headers['Content-Type']).toContain('image/svg+xml');expect(second.body).toBe(first.body);
  expect(f.render).toHaveBeenCalledTimes(1);expect(f.getImage).not.toHaveBeenCalled();
  expect(first.headers['Cache-Control']).toBe('public, max-age=300, s-maxage=1800, stale-while-revalidate=3600');
});
test('legacy and editorial queries cannot reuse each other’s memo entry',async()=>{
  const f=fixture();const editorial=await f.request(query);const legacy=await f.request({...query,art:undefined});
  expect(editorial.body).toContain('live-event-v3');expect(legacy.body).not.toContain('live-event-v3');expect(f.render).toHaveBeenCalledTimes(2);
});
test.each([{st:'replay'},{st:'247'},{shape:'poster'},{cat:'football'}])('route guard retains legacy composer for %j',async fields=>{
  const f=fixture(),res=await f.request({...query,...fields});expect(res.body).not.toContain('live-event-v3');
});
