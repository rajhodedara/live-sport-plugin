// Tests response-metadata forwarding with an Impit API model, not the native binary.
jest.mock('impit',()=>({Impit:jest.fn()}),{virtual:true});
jest.mock('undici',()=>({Agent:jest.fn().mockImplementation(()=>({})),request:jest.fn()}));
let fetch,response,request,safeFetch;
const initial='https://source.example/master.m3u8';
const final='https://mirror.example/final/master.m3u8';
beforeEach(()=>{
  jest.resetModules();
  response={status:200,url:final,headers:{},arrayBuffer:async()=>Uint8Array.from(Buffer.from('#EXTM3U')).buffer};
  fetch=jest.fn(async()=>response);const impit=require('impit');impit.Impit.mockImplementation(()=>({fetch}));
  request=require('undici').request;request.mockReset();request.mockRejectedValue(new Error('model fallback unavailable'));
  ({safeFetch}=require('../src/impitClient'));
});
test('Impit success forwards final response URL',async()=>{const r=await safeFetch(initial,{attempts:1});expect(r.url).toBe(final);expect(await r.text()).toBe('#EXTM3U');});
test('Impit response without URL falls back to requested URL',async()=>{response.url='';expect((await safeFetch(initial,{attempts:1})).url).toBe(initial);});
test('proxied Impit 403 preserves final URL without bypassing proxy',async()=>{
  response.status=403;const r=await safeFetch(initial,{proxyUrl:'http://proxy.invalid',attempts:1});expect(r.status).toBe(403);expect(r.url).toBe(final);expect(request).not.toHaveBeenCalled();
});
test('Impit 403 remains informative if undici fallback fails',async()=>{
  response.status=403;const r=await safeFetch(initial,{attempts:1});expect(r.status).toBe(403);expect(r.url).toBe(final);expect(request).toHaveBeenCalledTimes(1);
});
