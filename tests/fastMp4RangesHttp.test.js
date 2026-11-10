const http = require('node:http');
const net = require('node:net');
const express = require('express');
const undici = require('undici');
jest.mock('../src/services/OutboundUrlGuard', () => ({
  checkOutboundUrl: jest.fn(async () => ({ ok: true })),
  rejectBlockedUrl: jest.fn((res, verdict) => res.status(403).json(verdict)),
}));
const guard = require('../src/services/OutboundUrlGuard');
const originalConnect = net.Socket.prototype.connect, originalFetch = global.fetch;
const small = Buffer.from('abcdefghij'), large = Buffer.alloc(700000);
for (let i = 0; i < large.length; i++) large[i] = i % 251;
const seen = [];
const cancelled = new Set(), finishedBodies = new Set();
let upstream, addon, base, addonBase, dispatcher;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, range: req.headers.range, encoding: req.headers['accept-encoding'] });
    const payload = ['/large', '/latebad', '/ignore-large'].includes(req.url) ? large : small;
    if (req.url.startsWith('/ignore')) {
      if (req.url === '/ignore-progress' || req.url === '/ignore-disconnect') {
        res.writeHead(200, { 'content-type': 'video/mp4' }); res.flushHeaders(); res.write('first');
        const timer = setTimeout(() => { finishedBodies.add(req.url); res.end('second'); }, req.url === '/ignore-progress' ? 120 : 1000);
        res.once('close', () => { clearTimeout(timer); if (!res.writableFinished) cancelled.add(req.url); }); return;
      }
      const headers = { 'content-type': 'video/mp4' };
      if (req.url === '/ignore-length' || req.url === '/ignore-short') headers['content-length'] = '10';
      if (req.url === '/ignore-short') headers.connection = 'close';
      if (req.url === '/ignore-empty') headers['content-length'] = '0';
      if (req.url === '/ignore-range') headers['content-range'] = 'bytes 0-3/10';
      if (req.url === '/ignore-encoded') headers['content-encoding'] = 'gzip';
      if (req.url === '/ignore-html') headers['content-type'] = 'text/html';
      res.writeHead(200, headers); res.end(req.url === '/ignore-empty' ? '' : req.url === '/ignore-short' ? 'abc' : payload); return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match || req.url === '/ignore') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(payload); return; }
    const start = Number(match[1]), requestedEnd = Number(match[2]);
    if (start >= payload.length) { res.writeHead(416, { 'content-range': 'bytes */' + payload.length }); res.end(); return; }
    const end = Math.min(requestedEnd, payload.length - 1), probe = req.headers.range === 'bytes=0-0';
    const validRange = `bytes ${start}-${end}/${payload.length}`;
    let body = payload.subarray(start, end + 1), range = validRange, status = 206;
    if (req.url === '/badprobe' && probe) range = 'bytes 1-1/10';
    if (!probe && req.url === '/chunk200') status = 200;
    if (!probe && req.url === '/wrongoffset') range = `bytes ${start + 1}-${end + 1}/10`;
    if (!probe && req.url === '/short') body = body.subarray(0, body.length - 1);
    if (!probe && req.url === '/oversize') body = Buffer.concat([body, Buffer.from('x')]);
    if (!probe && req.url === '/latebad' && start > 0) range = `bytes ${start}-${end}/${payload.length + 1}`;
    const send = () => { res.writeHead(status, { 'content-type': 'video/mp4', 'content-range': range }); res.end(body); };
    if (!probe && req.url === '/large' && start === 0) { const timer = setTimeout(send, 35); res.once('close', () => clearTimeout(timer)); }
    else send();
  });
  const app = express(); app.use(require('../src/routes/streamProxy')); app.use(require('../src/routes/watch'));
  addon = http.createServer(app); await listen(upstream); await listen(addon);
  base = 'http://127.0.0.1:' + upstream.address().port;
  addonBase = 'http://127.0.0.1:' + addon.address().port;
  dispatcher = new undici.Agent();
  global.fetch = (url, options) => undici.fetch(url, { ...options, dispatcher });
  const ports = new Set([upstream.address().port, addon.address().port]);
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options !== 'object' || options.host !== '127.0.0.1' || !ports.has(Number(options.port))) throw new Error('TEST_NETWORK_BLOCKED');
    return originalConnect.apply(this, args);
  };
});
beforeEach(() => { seen.length = 0; guard.checkOutboundUrl.mockResolvedValue({ ok: true }); });
afterAll(async () => {
  try {
    await dispatcher.destroy();
    await Promise.all([upstream, addon].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    expect(upstream.listening || addon.listening).toBe(false);
  } finally { net.Socket.prototype.connect = originalConnect; global.fetch = originalFetch; }
});
function request(path, range, method = 'GET') {
  return new Promise(resolve => {
    const chunks = []; let response, finished = false;
    const done = error => {
      if (finished) return; finished = true;
      resolve({ status: response?.statusCode, headers: response?.headers || {}, body: Buffer.concat(chunks), complete: !!response?.complete, error: error?.code || error?.message });
    };
    const req = http.request(addonBase + path, { method, agent: false, headers: range ? { Range: range } : {} }, res => {
      response = res; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done()); res.on('error', done); res.on('aborted', () => done(new Error('aborted')));
    });
    req.setTimeout(2000, () => req.destroy(new Error('fixture timeout'))); req.on('error', done); req.end();
  });
}
const proxy = (path, extra = '') => '/api/fastmp4?' + new URLSearchParams({ url: base + path, concurrency: '3', chunk: String(256 * 1024) }) + extra;
test.each([['bytes=0-3', 'abcd'], ['bytes=6-', 'ghij'], ['bytes=-3', 'hij'], ['bytes=8-20', 'ij']])('wire response for %s matches bytes and framing', async (range, expected) => {
  const r = await request(proxy('/good'), range); expect(r.status).toBe(206); expect(r.body.toString()).toBe(expected);
  expect(Number(r.headers['content-length'])).toBe(expected.length); expect(r.complete).toBe(true); expect(r.error).toBeUndefined();
});
test.each(['bytes=20-30', 'bytes=10-', 'bytes=-0'])('wire %s returns 416 with known total and no data-window fetch', async range => {
  const r = await request(proxy('/good'), range); expect(r.status).toBe(416);
  expect(r.headers['content-range']).toBe('bytes */10'); expect(seen).toHaveLength(1);
});
test.each(['/badprobe', '/chunk200', '/wrongoffset', '/short', '/oversize'])('%s fails with 502 before video headers are committed', async path => {
  const r = await request(proxy(path), 'bytes=0-3'); expect(r.status).toBe(502);
  expect(r.headers['content-range']).toBeUndefined(); expect(r.complete).toBe(true);
});
test('parallel windows complete out of order but reconstruct the exact full file', async () => {
  const r = await request(proxy('/large')); expect(r.status).toBe(200); expect(r.body).toEqual(large);
  expect(r.complete).toBe(true); expect(r.error).toBeUndefined(); expect(seen).toHaveLength(4);
  expect(seen.map(x => x.range)).toEqual(['bytes=0-0', 'bytes=0-262143', 'bytes=262144-524287', 'bytes=524288-699999']);
});
test('invalid later window terminates an already-started transfer instead of sending it as valid video', async () => {
  const r = await request(proxy('/latebad')); expect(r.status).toBe(200);
  expect(r.complete).toBe(false); expect(r.error).toBeDefined(); expect(r.body.length).toBeLessThan(large.length);
  expect(r.body).toEqual(large.subarray(0, r.body.length));
});
test('HEAD ignores client Range and reports full representation size', async () => {
  const r = await request(proxy('/good'), 'bytes=4-6', 'HEAD'); expect(r.status).toBe(200);
  expect(r.headers['content-length']).toBe('10'); expect(r.body.length).toBe(0); expect(seen).toHaveLength(1);
});
test('legacy MP4 passthrough response remains byte-for-byte unchanged', async () => {
  const r = await request('/api/mp4proxy?' + new URLSearchParams({ url: base + '/good' }), 'bytes=2-5');
  expect(r.status).toBe(206); expect(r.body.toString()).toBe('cdef'); expect(r.headers['content-range']).toBe('bytes 2-5/10');
});
test('watch page HTML still responds without upstream fetching', async () => {
  const r = await request('/watch?' + new URLSearchParams({ url: 'https://embed.example/player', title: 'Fixture event' }));
  expect(r.status).toBe(200); expect(r.headers['content-type']).toContain('text/html'); expect(r.body.toString()).toContain('Fixture event'); expect(seen).toHaveLength(0);
});
test('blocked URL guard still prevents the probe', async () => {
  guard.checkOutboundUrl.mockResolvedValue({ ok: false, reason: 'blocked_address' });
  const r = await request(proxy('/good')); expect(r.status).toBe(403); expect(seen).toHaveLength(0);
});
test.each(['/ignore', '/ignore-length', '/ignore-large'])('%s reuses one full 200 response without fabricating partial headers', async path => {
  const r = await request(proxy(path), 'bytes=2-5'); expect(r.status).toBe(200);
  expect(r.body).toEqual(path === '/ignore-large' ? large : small); expect(r.complete).toBe(true);
  expect(r.headers['accept-ranges']).toBe('none'); expect(r.headers['content-range']).toBeUndefined();
  if (path === '/ignore-length') expect(r.headers['content-length']).toBe('10');
  else expect(r.headers['content-length']).toBeUndefined(); expect(seen).toHaveLength(1);
});
test('fallback HEAD retains known full length, sends no body and opens only one upstream request',async()=>{
  const r=await request(proxy('/ignore-length'),'bytes=2-5','HEAD');expect(r.status).toBe(200);
  expect(r.headers['content-length']).toBe('10');expect(r.body.length).toBe(0);expect(seen).toHaveLength(1);
});
test('empty ignored-Range representation is returned as a valid full 200',async()=>{
  const r=await request(proxy('/ignore-empty'),'bytes=0-3');expect(r.status).toBe(200);
  expect(r.headers['content-length']).toBe('0');expect(r.body.length).toBe(0);expect(r.complete).toBe(true);expect(seen).toHaveLength(1);
});
test.each(['/ignore-range','/ignore-encoded','/ignore-html'])('unsupported/contradictory full response %s still fails with 502',async path=>{
  const r=await request(proxy(path),'bytes=2-5');expect(r.status).toBe(502);expect(seen).toHaveLength(1);
});
test('truncated full response stays visibly incomplete and is never refetched',async()=>{
  const r=await request(proxy('/ignore-short'),'bytes=2-5');expect(r.status).toBe(200);
  expect(r.complete).toBe(false);expect(r.error).toBeDefined();expect(r.body.length).toBeLessThan(10);expect(seen).toHaveLength(1);
});
test('fallback delivers first bytes before upstream finishes the full body',async()=>{
  const result=await new Promise(resolve=>{
    const req=http.get(addonBase+proxy('/ignore-progress'),{agent:false,headers:{Range:'bytes=2-5'}},res=>{
      let early;const chunks=[];res.on('data',chunk=>{if(early===undefined)early=!finishedBodies.has('/ignore-progress');chunks.push(chunk);});
      res.on('end',()=>resolve({status:res.statusCode,early,body:Buffer.concat(chunks).toString()}));res.on('error',error=>resolve({error}));
    });req.on('error',error=>resolve({error}));req.setTimeout(2000,()=>req.destroy(new Error('fixture timeout')));
  });
  expect(result).toEqual({status:200,early:true,body:'firstsecond'});expect(seen).toHaveLength(1);
});
test('disconnect during fallback closes the reused real HTTP upstream',async()=>{
  const status=await new Promise(resolve=>{
    const req=http.get(addonBase+proxy('/ignore-disconnect'),{agent:false,headers:{Range:'bytes=2-5'}},res=>{
      res.once('data',()=>{req.destroy();resolve(res.statusCode);});res.on('error',()=>{});
    });req.on('error',()=>{});req.setTimeout(2000,()=>{req.destroy();resolve('fixture timeout');});
  });
  expect(status).toBe(200);const until=Date.now()+500;while(!cancelled.has('/ignore-disconnect')&&Date.now()<until)await new Promise(r=>setTimeout(r,5));
  expect(cancelled.has('/ignore-disconnect')).toBe(true);expect(seen).toHaveLength(1);
});
