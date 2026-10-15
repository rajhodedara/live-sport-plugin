const http=require('node:http');const net=require('node:net');
jest.mock('impit',()=>{throw new Error('test: native impit disabled');},{virtual:true});
jest.mock('undici',()=>{const actual=jest.requireActual('undici'),agents=[];return {...actual,_testAgents:agents,Agent:class extends actual.Agent{constructor(...args){super(...args);agents.push(this);}}};});
const undici=require('undici');const {safeFetch}=require('../src/impitClient');
let server,base;const originalConnect=net.Socket.prototype.connect;
const intervals=new Set(),delays=new Set(),closed=new Set(),seen=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
beforeAll(async()=>{
  server=http.createServer((req,res)=>{
    seen.push(req.url);req.socket.once('close',()=>closed.add(req.url));
    if(req.url==='/fast'){res.end('ok');return;}
    if(req.url==='/redirect'){res.writeHead(302,{location:'/drip'});res.end();return;}
    if(req.url==='/headers'){const t=setTimeout(()=>res.end('late'),600);delays.add(t);res.once('close',()=>{clearTimeout(t);delays.delete(t);});return;}
    res.writeHead(200);res.flushHeaders();
    const interval=setInterval(()=>res.write('x'),20);intervals.add(interval);
    const timer=setTimeout(()=>res.end('done'),600);delays.add(timer);
    res.once('close',()=>{clearInterval(interval);intervals.delete(interval);clearTimeout(timer);delays.delete(timer);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  net.Socket.prototype.connect=function(...args){const a=Array.isArray(args[0])?args[0][0]:args[0];if(typeof a!=='object'||a.host!=='127.0.0.1'||Number(a.port)!==server.address().port)throw new Error('TEST_NETWORK_BLOCKED');return originalConnect.apply(this,args);};
});
beforeEach(()=>{seen.length=0;closed.clear();});
afterEach(async()=>{await pause(25);for(const t of intervals)clearInterval(t);for(const t of delays)clearTimeout(t);intervals.clear();delays.clear();});
afterAll(async()=>{await Promise.all(undici._testAgents.map(a=>a.destroy()));await new Promise(r=>{server.closeAllConnections();server.close(r);});net.Socket.prototype.connect=originalConnect;expect(server.listening).toBe(false);});
test('fast body succeeds and remains readable after deadline timer cleanup',async()=>{const r=await safeFetch(base+'/fast',{timeoutMs:250});await pause(300);expect(await r.text()).toBe('ok');});
test('continuously arriving body exceeds inactivity window but hits total deadline',async()=>{
  const started=performance.now();await expect(safeFetch(base+'/drip',{timeoutMs:100})).rejects.toMatchObject({code:'ETIMEDOUT'});
  expect(performance.now()-started).toBeLessThan(450);await pause(30);expect(closed.has('/drip')).toBe(true);
});
test('redirect and final body share one deadline',async()=>{
  await expect(safeFetch(base+'/redirect',{timeoutMs:100})).rejects.toMatchObject({code:'ETIMEDOUT'});await pause(30);expect(seen).toContain('/drip');expect(closed.has('/drip')).toBe(true);
});
test('caller abort during HTTP body closes upstream connection',async()=>{
  const c=new AbortController(),reason=new Error('fixture user cancel');const p=safeFetch(base+'/abort',{timeoutMs:1000,signal:c.signal});
  const done=p.catch(e=>e);const until=Date.now()+500;while(!seen.includes('/abort')&&Date.now()<until)await pause(5);expect(seen).toContain('/abort');c.abort(reason);expect(await done).toBe(reason);await pause(30);expect(closed.has('/abort')).toBe(true);
});
test('pre-aborted caller never connects to HTTP upstream',async()=>{
  const c=new AbortController(),reason=new Error('fixture pre-cancel');c.abort(reason);await expect(safeFetch(base+'/fast',{signal:c.signal})).rejects.toBe(reason);expect(seen).toHaveLength(0);
});
test('delayed headers are cancelled by the total deadline',async()=>{
  await expect(safeFetch(base+'/headers',{timeoutMs:100})).rejects.toMatchObject({code:'ETIMEDOUT'});await pause(30);expect(closed.has('/headers')).toBe(true);
});
