const http = require('node:http');
const net = require('node:net');
jest.mock('impit', () => { throw new Error('fixture: native impit disabled'); }, { virtual: true });
jest.mock('undici', () => {
  const actual = jest.requireActual('undici'), agents = [];
  return { ...actual, _testAgents: agents, Agent: class extends actual.Agent {
    constructor(...args) { super(...args); agents.push(this); }
  } };
});
const undici = require('undici');
const { safeFetch } = require('../src/impitClient');
const originalConnect = net.Socket.prototype.connect;
let source, target, a, b;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const headers = () => ({ Authorization: 'Bearer FAKE', Cookie: 'session=FAKE',
  Cookie2: 'version=FAKE', 'Proxy-Authorization': 'Basic FAKE', Host: '127.0.0.1:9',
  'X-Fixture': 'preserved', Referer: 'https://fixture.example/' });
const echo = async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ headers: req.headers, method: req.method, body }));
};
beforeAll(async () => {
  source = http.createServer((req, res) => {
    if (req.url === '/echo') return void echo(req, res);
    req.resume();
    const location = req.url === '/same' ? '/echo' : b + (req.url === '/return' ? '/return' : '/echo');
    res.writeHead(req.url === '/post' ? 307 : 302, { location }); res.end();
  });
  target = http.createServer((req, res) => {
    if (req.url === '/return') { req.resume(); res.writeHead(302, { location: a + '/echo' }); res.end(); }
    else void echo(req, res);
  });
  await listen(source); await listen(target);
  a = 'http://127.0.0.1:' + source.address().port;
  b = 'http://127.0.0.1:' + target.address().port;
  const ports = new Set([source.address().port, target.address().port]);
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options !== 'object' || options.host !== '127.0.0.1' || !ports.has(Number(options.port))) throw new Error('TEST_NETWORK_BLOCKED');
    return originalConnect.apply(this, args);
  };
});
afterAll(async () => {
  try {
    await Promise.all(undici._testAgents.map(agent => agent.destroy()));
    await Promise.all([source, target].map(server => new Promise(resolve => {
      server.closeAllConnections(); server.close(resolve);
    })));
    expect(source.listening || target.listening).toBe(false);
  } finally { net.Socket.prototype.connect = originalConnect; }
});
function stripped(result, origin) {
  for (const name of ['authorization', 'cookie', 'cookie2', 'proxy-authorization']) expect(result.headers[name]).toBeUndefined();
  expect(result.headers.host).toBe(new URL(origin).host);
  expect(result.headers['x-fixture']).toBe('preserved');
  expect(result.headers.referer).toBe('https://fixture.example/');
}
test.each([
  ['object', h => h],
  ['flat strings', h => Object.entries(h).flat()],
  ['Map iterable', h => new Map(Object.entries(h))],
  ['Headers', h => new Headers(h)],
])('real HTTP strips sensitive %s headers on a changed port', async (_, form) => {
  const result = await (await safeFetch(a + '/foreign', { headers: form(headers()) })).json();
  stripped(result, b); expect(result.method).toBe('GET');
});
test('same-origin redirect retains credentials and caller Host', async () => {
  const result = await (await safeFetch(a + '/same', { headers: headers() })).json();
  expect(result.headers.authorization).toBe('Bearer FAKE');
  expect(result.headers.cookie).toBe('session=FAKE');
  expect(result.headers.host).toBe('127.0.0.1:9');
});
test('A to B to A does not restore credentials', async () => {
  const result = await (await safeFetch(a + '/return', { headers: headers() })).json(); stripped(result, a);
});
test('307 preserves POST payload without credential headers', async () => {
  const result = await (await safeFetch(a + '/post', { headers: headers(), method: 'POST', body: 'fixture payload' })).json();
  stripped(result, b); expect(result.method).toBe('POST'); expect(result.body).toBe('fixture payload');
});
test('ordinary redirect without credentials still succeeds', async () => {
  const response = await safeFetch(a + '/foreign'); expect(response.status).toBe(200);
  expect((await response.json()).headers.authorization).toBeUndefined();
});
