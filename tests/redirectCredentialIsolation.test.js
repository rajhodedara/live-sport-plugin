// Model tests for undici's explicit redirect loop; no public network or native binary.
jest.mock('impit',()=>{throw new Error('test: native impit disabled');},{virtual:true});
jest.mock('undici',()=>({request:jest.fn(),Agent:class{}}));
const {request}=require('undici');const {safeFetch}=require('../src/impitClient');
const initial='https://source.example/path/list';
const auth={Authorization:'Bearer FAKE',Cookie:'audit=FAKE','Proxy-Authorization':'Basic FAKE',Cookie2:'audit2=FAKE',Host:'override.example','User-Agent':'audit-UA',Referer:'https://embed.example/',Origin:'https://embed.example','X-Custom':'keep'};
const response=(statusCode,location)=>({statusCode,headers:location?{location}:{},body:{dump:jest.fn(async()=>{}),arrayBuffer:async()=>Uint8Array.from(Buffer.from('ok')).buffer}});
function flat(headers){
  if(!headers)return {};
  const entries=Array.isArray(headers)&&headers.every(x=>typeof x==='string')?headers.reduce((out,x,i)=>{if(i%2===0)out.push([x,headers[i+1]]);return out;},[]):
    typeof headers[Symbol.iterator]==='function'?Array.from(headers):Object.entries(headers);
  return Object.fromEntries(entries.map(([k,v])=>[k.toLowerCase(),v]));
}
function expectStripped(headers){const h=flat(headers);for(const k of ['authorization','cookie','cookie2','proxy-authorization','host'])expect(h[k]).toBeUndefined();}
beforeEach(()=>request.mockReset());
test.each([301,302,303,307,308])('%s cross-origin redirect strips known sensitive headers',async status=>{
  request.mockResolvedValueOnce(response(status,'https://target.example/final')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{headers:{...auth},attempts:1});expectStripped(request.mock.calls[1][1].headers);
  expect(flat(request.mock.calls[1][1].headers)).toMatchObject({'user-agent':'audit-UA',referer:'https://embed.example/',origin:'https://embed.example','x-custom':'keep'});
});
test.each(['/next','https://source.example/next','https://source.example:443/next'])('same-origin %s preserves credentials',async location=>{
  request.mockResolvedValueOnce(response(302,location)).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{headers:{...auth},attempts:1});expect(flat(request.mock.calls[1][1].headers)).toEqual(flat(auth));
});
test.each(['http://source.example/next','https://source.example:444/next'])('scheme/port change %s is a different origin',async location=>{
  request.mockResolvedValueOnce(response(302,location)).mockResolvedValueOnce(response(200));await safeFetch(initial,{headers:{...auth},attempts:1});expectStripped(request.mock.calls[1][1].headers);
});
test('removal is case-insensitive and leaves frozen caller input untouched',async()=>{
  const input=Object.freeze({aUtHoRiZaTiOn:'Bearer FAKE',cOoKiE:'audit=FAKE',hOsT:'override.example','X-Custom':'keep'});
  request.mockResolvedValueOnce(response(302,'https://target.example/')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{headers:input,attempts:1});expectStripped(request.mock.calls[1][1].headers);expect(input.aUtHoRiZaTiOn).toBe('Bearer FAKE');expect(request.mock.calls[0][1].headers).toBe(input);
});
test.each([
 ['flat list',()=>['Authorization','Bearer FAKE','Cookie','audit=FAKE','Host','override.example','X-Custom','keep']],
 ['pair iterable',()=>new Map([['Authorization','Bearer FAKE'],['Cookie','audit=FAKE'],['Host','override.example'],['X-Custom','keep']])],
 ['Headers',()=>new Headers({Authorization:'Bearer FAKE',Cookie:'audit=FAKE',Host:'override.example','X-Custom':'keep'})],
 ['null-prototype object',()=>Object.assign(Object.create(null),{Authorization:'Bearer FAKE',Cookie:'audit=FAKE',Host:'override.example','X-Custom':'keep'})],
])('%s is filtered without losing ordinary headers',async(_name,build)=>{
  const input=build(),before=flat(input);request.mockResolvedValueOnce(response(302,'https://target.example/')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{headers:input,attempts:1});expectStripped(request.mock.calls[1][1].headers);expect(flat(request.mock.calls[1][1].headers)['x-custom']).toBe('keep');expect(flat(input)).toEqual(before);
});
test('A to B to A never restores the removed original credentials',async()=>{
  request.mockResolvedValueOnce(response(302,'https://target.example/b')).mockResolvedValueOnce(response(302,'https://source.example/back')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{headers:{...auth},attempts:1});expectStripped(request.mock.calls[1][1].headers);expectStripped(request.mock.calls[2][1].headers);
});
test('same-origin hop followed by foreign hop strips only at the boundary',async()=>{
  request.mockResolvedValueOnce(response(302,'/next')).mockResolvedValueOnce(response(302,'https://target.example/')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{headers:{...auth},attempts:1});expect(flat(request.mock.calls[1][1].headers).authorization).toBe('Bearer FAKE');expectStripped(request.mock.calls[2][1].headers);
});
test('307 cross-origin preserves method and body while stripping credentials',async()=>{
  request.mockResolvedValueOnce(response(307,'https://target.example/')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{method:'POST',body:'payload',headers:{...auth,'content-length':'7'},attempts:1});
  expect(request.mock.calls[1][1].method).toBe('POST');expect(request.mock.calls[1][1].body).toBe('payload');expectStripped(request.mock.calls[1][1].headers);
});
test('302 keeps existing GET conversion and removes lower-case content-length',async()=>{
  request.mockResolvedValueOnce(response(302,'https://target.example/')).mockResolvedValueOnce(response(200));
  await safeFetch(initial,{method:'POST',body:'payload',headers:{...auth,'content-length':'7'},attempts:1});
  expect(request.mock.calls[1][1].method).toBe('GET');expect(request.mock.calls[1][1].body).toBeUndefined();expect(flat(request.mock.calls[1][1].headers)['content-length']).toBeUndefined();expectStripped(request.mock.calls[1][1].headers);
});
test('missing Location does not follow or alter caller headers',async()=>{
  const input={...auth};request.mockResolvedValueOnce(response(302));await safeFetch(initial,{headers:input,attempts:1});expect(request).toHaveBeenCalledTimes(1);expect(input).toEqual(auth);
});
test('unsupported Location protocol is not followed',async()=>{
  request.mockResolvedValueOnce(response(302,'file:///fixture'));const r=await safeFetch(initial,{headers:{...auth},attempts:1});expect(r.status).toBe(302);expect(request).toHaveBeenCalledTimes(1);
});
