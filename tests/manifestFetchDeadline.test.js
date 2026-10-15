// Controlled-clock tests for the manifest helper's existing retry policy.
jest.mock('../src/container',()=>({resolve:jest.fn()}));
jest.mock('../src/impitClient',()=>({safeFetch:jest.fn()}));
const {safeFetch}=require('../src/impitClient');
const {fetchUpstreamManifest}=require('../src/manifestProxy');
const track=p=>{const state={};p.then(value=>state.value=value,error=>state.error=error);return state;};
const timeout=()=>Object.assign(new Error('safeFetch timeout'),{code:'ETIMEDOUT'});
beforeEach(()=>{jest.useFakeTimers();safeFetch.mockReset();});
afterEach(()=>{jest.clearAllTimers();jest.useRealTimers();});
test('expired first attempt is not given a fresh ten-second budget',async()=>{
  safeFetch.mockImplementation((_url,opts)=>new Promise((_,reject)=>setTimeout(()=>reject(timeout()),opts.timeoutMs)));
  const state=track(fetchUpstreamManifest('https://fixture.example/list','',''));await jest.advanceTimersByTimeAsync(10000);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(safeFetch).toHaveBeenCalledTimes(1);expect(jest.getTimerCount()).toBe(0);
});
test('retry receives only time left after first attempt and backoff',async()=>{
  safeFetch.mockImplementationOnce(()=>new Promise(resolve=>setTimeout(()=>resolve({ok:false,status:503}),6000)))
    .mockImplementation((_url,opts)=>new Promise((_,reject)=>setTimeout(()=>reject(timeout()),opts.timeoutMs)));
  const state=track(fetchUpstreamManifest('https://fixture.example/list','',''));await jest.advanceTimersByTimeAsync(10000);
  expect(state.error?.code).toBe('ETIMEDOUT');expect(safeFetch).toHaveBeenCalledTimes(2);expect(safeFetch.mock.calls[1][1].timeoutMs).toBe(3600);expect(jest.getTimerCount()).toBe(0);
});
test('quick transient failure still recovers using the existing retry',async()=>{
  safeFetch.mockResolvedValueOnce({ok:false,status:503}).mockResolvedValueOnce({ok:true,status:200,text:async()=>'#EXTM3U\nsegment.ts'});
  const state=track(fetchUpstreamManifest('https://fixture.example/list','',''));await jest.advanceTimersByTimeAsync(400);
  expect(state.value).toBe('#EXTM3U\nsegment.ts');expect(safeFetch).toHaveBeenCalledTimes(2);expect(safeFetch.mock.calls[1][1].timeoutMs).toBe(9600);expect(jest.getTimerCount()).toBe(0);
});
