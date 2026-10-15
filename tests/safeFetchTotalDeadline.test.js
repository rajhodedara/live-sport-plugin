// Controlled-clock transport models; HTTP socket cancellation is tested separately.
jest.mock('impit',()=>({Impit:jest.fn()}),{virtual:true});
jest.mock('undici',()=>({Agent:jest.fn().mockImplementation(()=>({})),request:jest.fn()}));
let fetch,request,safeFetch;
const url='https://fixture.example/live';
const bytes=()=>Uint8Array.from(Buffer.from('ok')).buffer;
const response=()=>({status:200,headers:{},arrayBuffer:async()=>bytes()});
const undiciResponse=()=>({statusCode:200,headers:{},body:{arrayBuffer:async()=>bytes(),dump:async()=>{}}});
const track=p=>{const state={};p.then(value=>state.value=value,error=>state.error=error);return state;};
const hang=(signal,onAbort)=>new Promise((resolve,reject)=>{
  if(signal)signal.addEventListener('abort',()=>{onAbort?.();reject(signal.reason);},{once:true});
});
beforeEach(()=>{
  jest.resetModules();jest.useFakeTimers();
  fetch=jest.fn(async()=>response());require('impit').Impit.mockImplementation(()=>({fetch}));
  request=require('undici').request;request.mockReset();request.mockResolvedValue(undiciResponse());
  ({safeFetch}=require('../src/impitClient'));
});
afterEach(()=>{jest.clearAllTimers();jest.useRealTimers();});
test('fast completion clears deadline and caller listener',async()=>{
  const c=new AbortController();const add=jest.spyOn(c.signal,'addEventListener'),remove=jest.spyOn(c.signal,'removeEventListener');
  const r=await safeFetch(url,{timeoutMs:50,signal:c.signal});expect(await r.text()).toBe('ok');expect(jest.getTimerCount()).toBe(0);
  expect(add).toHaveBeenCalled();expect(remove).toHaveBeenCalledWith('abort',add.mock.calls[0][1]);expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
test('body timeout aborts Impit API model and does not fall back',async()=>{
  let cancelled=0;fetch.mockImplementation(async(_u,opts)=>({...response(),arrayBuffer:()=>hang(opts.signal,()=>cancelled++)}));
  const state=track(safeFetch(url,{timeoutMs:50,attempts:3}));await jest.advanceTimersByTimeAsync(60);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(cancelled).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
test('header timeout cancels before retry or fallback',async()=>{
  let cancelled=0;fetch.mockImplementation((_u,opts)=>hang(opts.signal,()=>cancelled++));
  const state=track(safeFetch(url,{timeoutMs:50,attempts:3}));await jest.advanceTimersByTimeAsync(60);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(cancelled).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();
});
test('caller abort during body propagates original reason',async()=>{
  const c=new AbortController(),reason=new Error('fixture user cancelled');let cancelled=0;
  fetch.mockImplementation(async(_u,opts)=>({...response(),arrayBuffer:()=>hang(opts.signal,()=>cancelled++)}));
  const state=track(safeFetch(url,{timeoutMs:1000,signal:c.signal}));await jest.advanceTimersByTimeAsync(1);c.abort(reason);await jest.advanceTimersByTimeAsync(0);
  expect(state.error).toBe(reason);expect(cancelled).toBe(1);expect(request).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
test('already aborted caller produces no transport call and preserves reason',async()=>{
  const c=new AbortController(),reason=new Error('fixture already cancelled');c.abort(reason);
  await expect(safeFetch(url,{signal:c.signal})).rejects.toBe(reason);expect(fetch).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
test('caller abort cancels backoff timer without another attempt',async()=>{
  fetch.mockRejectedValue(new Error('fixture network reset'));const c=new AbortController(),reason=new Error('fixture backoff cancel');
  const state=track(safeFetch(url,{timeoutMs:3000,attempts:3,signal:c.signal}));await jest.advanceTimersByTimeAsync(10);c.abort(reason);await jest.advanceTimersByTimeAsync(0);
  expect(state.error).toBe(reason);expect(fetch).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
test('retry backoff consumes the same total budget',async()=>{
  fetch.mockRejectedValue(new Error('fixture network reset'));const state=track(safeFetch(url,{timeoutMs:50,attempts:3}));await jest.advanceTimersByTimeAsync(60);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(fetch).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();expect(jest.getTimerCount()).toBe(0);
});
test('fallback body remains within the original deadline',async()=>{
  fetch.mockRejectedValue(new Error('InvalidCertificate'));let cancelled=0;
  request.mockImplementation(async(_u,opts)=>({...undiciResponse(),body:{arrayBuffer:()=>hang(opts.signal,()=>cancelled++)}}));
  const state=track(safeFetch(url,{timeoutMs:50,attempts:1}));await jest.advanceTimersByTimeAsync(60);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(cancelled).toBe(1);expect(request).toHaveBeenCalledTimes(1);
});
test('403 fallback timeout is not swallowed as an ordinary 403 response',async()=>{
  fetch.mockResolvedValue({...response(),status:403});request.mockImplementation(async(_u,opts)=>({...undiciResponse(),body:{arrayBuffer:()=>hang(opts.signal)}}));
  const state=track(safeFetch(url,{timeoutMs:50,attempts:1}));await jest.advanceTimersByTimeAsync(60);expect(state.error?.code).toBe('ETIMEDOUT');expect(state.value).toBeUndefined();
});
test('deadline settles caller even if a transport ignores abort',async()=>{
  fetch.mockResolvedValue({...response(),arrayBuffer:()=>new Promise(()=>{})});const state=track(safeFetch(url,{timeoutMs:50,attempts:1}));await jest.advanceTimersByTimeAsync(60);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(jest.getTimerCount()).toBe(0);
  // This proves caller settlement, not physical cancellation of a non-cooperating native engine.
});
