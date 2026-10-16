import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
const sourceRoot = process.env.LSP_REQUEST_ROOT;
if (!sourceRoot) throw new Error('LSP_REQUEST_ROOT is required');
let directory, server, port;
const previousBase = process.env.BASE_URL;
before(async () => {
  delete process.env.BASE_URL;
  directory = await mkdtemp(join(tmpdir(), 'lsp-url-http-'));
  await mkdir(join(directory, 'resolver/src/http'), { recursive: true });
  await mkdir(join(directory, 'resolver/src/resolve'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const file of ['http/router.js', 'http/static.js', 'cache.js']) {
    await copyFile(resolve(sourceRoot, 'resolver/src', file), join(directory, 'resolver/src', file));
  }
  // Preserve real ESM router/cache/static modules; substitute provider resolution only.
  await writeFile(join(directory, 'resolver/src/resolve/run.js'), 'export async function run(body, origin) { return {ok:true, fixture:true, body, origin} }');
  const { route } = await import(pathToFileURL(join(directory, 'resolver/src/http/router.js')));
  server = createServer(route);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
});
after(async () => {
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (directory) await rm(directory, { recursive: true, force: true });
  if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase;
});
function request(path, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, res => {
      let text = ''; res.on('data', c => text += c); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture timeout'))); req.end(body);
  });
}
for (const path of ['/health','/api/health']) test('real HTTP preserves ' + path, async () => {
  const r = await request(path); assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).ok, true);
});
test('real shared-cache POST/GET/DELETE contract stays usable', async () => {
  const path = '/api/cache/urltest:match:one';
  assert.equal((await request(path,'POST','{"streams":[{"url":"fixture"}]}')).status, 200);
  assert.equal(JSON.parse((await request(path)).text).streams[0].url,'fixture');
  assert.equal((await request(path,'DELETE')).status,200); assert.equal(JSON.parse((await request(path)).text).status,'miss');
});
test('real shared-cache claim still coalesces ownership', async () => {
  const path = '/api/cache/urltest:match:claim?claim=1';
  assert.equal(JSON.parse((await request(path)).text).ok,true);
  assert.equal(JSON.parse((await request(path)).text).ok,false);
});
test('real cache prune and stats endpoints remain usable', async () => {
  await request('/api/cache/urltest:ended:one','POST','{"streams":[]}');
  const prune = await request('/api/cache/unused','POST','{"activeIds":[]}');
  assert.equal(prune.status,200); assert.ok(JSON.parse(prune.text).pruned >= 1);
  assert.equal((await request('/api/cache-stats')).status,200);
});
test('stream route passes the selected forwarded origin to its resolver fixture', async () => {
  const r = await request('/api/stream','POST','{"url":"fixture"}',{'x-forwarded-host':'front.test:8443, ignored.test','x-forwarded-proto':'https, http'});
  assert.equal(r.status,200); assert.equal(JSON.parse(r.text).origin,'https://front.test:8443');
});
test('stream method guard remains 405', async () => { assert.equal((await request('/api/stream')).status,405); });
test('invalid stream JSON remains 400', async () => { assert.equal((await request('/api/stream','POST','{')).status,400); });
test('unknown path remains 404', async () => { assert.equal((await request('/unknown')).status,404); });

for (const [name, path, headers] of [
  ['malformed forwarded host','/api/health',{'x-forwarded-host':'['}],
  ['malformed forwarded protocol','/api/health',{'x-forwarded-proto':':'}],
  ['malformed absolute request target','http://[',{}],
]) test(name + ' returns 400 and isolated server survives', async () => {
  // Baseline rejection may terminate the process; contain it in this disposable child.
  const code = `
    import { createServer, request } from 'node:http';
    import { route } from ${JSON.stringify(pathToFileURL(join(directory,'resolver/src/http/router.js')).href)};
    const server=createServer(route), timer=setTimeout(()=>process.exit(2),3000);
    server.listen(0,'127.0.0.1',async()=>{
      const read=(path,headers={})=>new Promise((resolve,reject)=>{
        const req=request({host:'127.0.0.1',port:server.address().port,path,headers,agent:false},res=>{
          let body='';res.on('data',c=>body+=c);res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body}));
        });req.on('error',reject);req.end();
      });
      try {
        const invalid=await read(${JSON.stringify(path)},${JSON.stringify(headers)});
        const healthy=await read('/api/health');console.log(JSON.stringify({invalid,healthy}));
        clearTimeout(timer);server.closeAllConnections();server.close();
      } catch(error){console.error(error);process.exit(3);}
    });`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
    let stdout='', stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
  });
  assert.equal(result.code,0,result.stderr);
  const data=JSON.parse(result.stdout.trim());
  assert.equal(data.invalid.status,400);assert.deepEqual(JSON.parse(data.invalid.body),{ok:false,error:'invalid request URL'});
  assert.equal(data.healthy.status,200);assert.equal(JSON.parse(data.healthy.body).ok,true);
});
