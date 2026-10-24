const fs = require('fs'), path = require('path'), vm = require('vm');
function fixture(baseUrl) {
  const calls = {};
  const run = jest.fn(async (body, origin) => ({ ok: true, body, origin }));
  const serveStatic = jest.fn(() => false);
  const context = { URL, Buffer, process: { env: baseUrl === undefined ? {} : { BASE_URL: baseUrl }, uptime: () => 17 }, run, serveStatic };
  for (const name of ['cacheGet','cacheClaim','cacheSet','cacheDelete','cachePrune','cacheStats']) {
    calls[name] = jest.fn(() => ({ fixture: name })); context[name] = calls[name];
  }
  // Replace only ESM imports/export syntax; execute the complete router logic.
  const source = fs.readFileSync(path.join(__dirname, '../resolver/src/http/router.js'), 'utf8').replace(/^import .*\n/gm, '').replace('export async function route', 'async function route');
  vm.createContext(context); vm.runInContext(source, context);
  return { route: context.route, calls, run, serveStatic };
}
function request(url = '/api/health', headers = { host: 'resolver.test' }, method = 'GET', body = '') {
  return { url, headers, method, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
}
function response() {
  return { status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}
test.each([
  ['invalid forwarded host', '/api/health', {host:'resolver.test','x-forwarded-host':'['}],
  ['invalid Host', '/api/health', {host:'['}],
  ['malformed absolute target', 'http://[', {host:'resolver.test'}],
  ['invalid forwarded port', '/api/health', {host:'resolver.test','x-forwarded-host':'resolver.test:not-a-port'}],
  ['malformed protocol', '/api/health', {host:'resolver.test','x-forwarded-proto':':' }],
  ['array forwarded host', '/api/health', {host:'resolver.test','x-forwarded-host':['[']}],
  ['array forwarded protocol', '/api/health', {host:'resolver.test','x-forwarded-proto':['http']}],
])('%s settles with a generic 400 before dispatch', async (_, url, headers) => {
  const f = fixture(), res = response();
  await expect(f.route(request(url, headers), res)).resolves.toBeUndefined();
  expect(res.status).toBe(400); expect(JSON.parse(res.body)).toEqual({ok:false,error:'invalid request URL'});
  expect(f.run).not.toHaveBeenCalled(); expect(f.serveStatic).not.toHaveBeenCalled();
  for (const fn of Object.values(f.calls)) expect(fn).not.toHaveBeenCalled();
});
test('invalid BASE_URL is contained without leaking its credentials', async () => {
  const f = fixture('http://fake-user:fake-secret@['), res = response();
  await expect(f.route(request('/api/health', {}), res)).resolves.toBeUndefined();
  expect(res.status).toBe(400); expect(res.body).not.toContain('fake-secret');
});
test.each(['/health', '/api/health'])('%s preserves healthy response', async url => {
  const f = fixture(), res = response(); await f.route(request(url), res);
  expect(res.status).toBe(200); expect(JSON.parse(res.body)).toEqual({ok:true,uptime:17});
});
test('missing host retains its existing plain-text response', async () => {
  const f = fixture(), res = response(); await f.route(request('/health', {}), res);
  expect(res.status).toBe(400); expect(res.body).toBe('missing host');
});
test.each([
  ['first forwarded values','https://front.test:8443',{host:'internal.test','x-forwarded-host':'front.test:8443, other.test','x-forwarded-proto':'https, http'},undefined],
  ['BASE_URL','https://configured.test',{host:'internal.test'},'https://configured.test'],
  ['forwarded host override','http://front.test',{host:'internal.test','x-forwarded-host':'front.test'},'https://configured.test'],
  ['IPv6','http://[::1]:7003',{host:'[::1]:7003'},undefined],
])('%s preserves resolver origin selection', async (_, origin, headers, baseUrl) => {
  const f = fixture(baseUrl), res = response(); await f.route(request('/api/stream', headers, 'POST', '{"url":"fixture"}'), res);
  expect(res.status).toBe(200); expect(f.run).toHaveBeenCalledWith({url:'fixture'},origin);
});
test('valid BASE_URL permits missing Host as before', async () => {
  const f = fixture('https://configured.test'), res = response(); await f.route(request('/health', {}), res); expect(res.status).toBe(200);
});
test.each([
  ['/api/cache/source%3Amatch%3A1','GET','', 'cacheGet'],
  ['/api/cache/source%3Amatch%3A1?claim=1&ttl=5000','GET','', 'cacheClaim'],
  ['/api/cache/source%3Amatch%3A1','POST','{"streams":[]}', 'cacheSet'],
  ['/api/cache/source%3Amatch%3A1','DELETE','', 'cacheDelete'],
  ['/api/cache/source%3Amatch%3A1','POST','{"activeIds":[]}', 'cachePrune'],
  ['/api/cache-stats','GET','', 'cacheStats'],
])('valid cache dispatch %s %s remains intact', async (url, method, body, name) => {
  const f = fixture(), res = response(); await f.route(request(url,{host:'resolver.test'},method,body),res);
  expect(res.status).toBe(200); expect(f.calls[name]).toHaveBeenCalledTimes(1);
});
test('stream invalid JSON remains a handled 400', async () => {
  const f = fixture(), res = response(); await f.route(request('/api/stream',{host:'resolver.test'},'POST','{'),res);
  expect(res.status).toBe(400); expect(JSON.parse(res.body).error).toBe('invalid json'); expect(f.run).not.toHaveBeenCalled();
});
test('resolution failure still uses the existing 500 boundary', async () => {
  const f = fixture(), res = response(); f.run.mockRejectedValueOnce(new Error('fixture failure'));
  await f.route(request('/api/stream',{host:'resolver.test'},'POST','{}'),res); expect(res.status).toBe(500);
});
test('unknown path keeps static dispatch and 404', async () => {
  const f = fixture(), res = response(); await f.route(request('/unknown'),res);
  expect(f.serveStatic).toHaveBeenCalledWith('/unknown',res); expect(res.status).toBe(404);
});
