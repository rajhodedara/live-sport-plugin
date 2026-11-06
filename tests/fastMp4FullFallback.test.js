const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
jest.mock('../src/services/OutboundUrlGuard', () => ({ checkOutboundUrl: async () => ({ ok: true }), rejectBlockedUrl: jest.fn() }));
const router = require('../src/routes/streamProxy');
const handle = router.stack.find(layer => layer.route?.path === '/api/fastmp4').route.stack[0].handle;
const payload = 'abcdefghij';
class Output extends Writable {
  constructor() { super(); this.code = 200; this.headers = {}; this.headersSent = false; this.chunks = []; }
  _write(chunk, _encoding, callback) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); callback(); }
  status(code) { this.code = code; return this; }
  setHeader(key, value) { this.headers[key.toLowerCase()] = String(value); }
  removeHeader(key) { delete this.headers[key.toLowerCase()]; }
  send(value) { this.end(value); return this; }
}
function input(range, method = 'GET') {
  return Object.assign(new EventEmitter(), { query: { url: 'https://fixture.example/video' }, headers: range ? { range } : {}, method });
}
async function run(response, range = 'bytes=2-5', method = 'GET') {
  global.fetch.mockResolvedValueOnce(response); const res = new Output();
  await handle(input(range, method), res); return res;
}
const full = (body = payload, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'video/mp4', ...headers } });
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { jest.useRealTimers(); });
test.each(['bytes=2-5', 'bytes=900-', 'bytes=-3', 'bytes=0-1,8-9', undefined])('full 200 ignores client range %s honestly and fetches only once', async range => {
  const r = await run(full(payload, { 'content-length': '10', 'content-type': 'video/mp4' }), range);
  expect(r.code).toBe(200); expect(r.headers['content-range']).toBeUndefined(); expect(r.headers['accept-ranges']).toBe('none');
  expect(r.headers['content-length']).toBe('10'); expect(Buffer.concat(r.chunks).toString()).toBe(payload);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('valid application/mp4 full response is accepted', async () => {
  const r = await run(full(payload, { 'content-length': '10', 'content-type': 'application/mp4; codecs="avc1"' }));
  expect(r.code).toBe(200);
  expect(r.headers['content-type']).toBe('application/mp4; codecs="avc1"');
  expect(Buffer.concat(r.chunks).toString()).toBe(payload);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('unknown-length 200 streams without inventing Content-Length', async () => {
  const r = await run(full()); expect(r.code).toBe(200); expect(r.headers['content-length']).toBeUndefined();
  expect(Buffer.concat(r.chunks).toString()).toBe(payload); expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('zero-length full response succeeds', async () => {
  const r = await run(full('', { 'content-length': '0' })); expect(r.code).toBe(200); expect(r.headers['content-length']).toBe('0'); expect(r.chunks).toHaveLength(0);
});
test('HEAD cancels full body without sending bytes or refetching', async () => {
  const response = full(payload, { 'content-length': '10' }), cancel = jest.spyOn(response.body, 'cancel');
  const r = await run(response, 'bytes=2-5', 'HEAD'); expect(r.code).toBe(200); expect(r.headers['content-length']).toBe('10');
  expect(r.chunks).toHaveLength(0); expect(cancel).toHaveBeenCalledTimes(1); expect(global.fetch).toHaveBeenCalledTimes(1);
});
test.each([
  { 'content-range': 'bytes 0-3/10' }, { 'content-length': '-1' },
  { 'content-length': '10x' }, { 'content-length': '9007199254740992' }, { 'content-encoding': 'gzip' },
  { 'content-type': 'text/html' },
])('contradictory or unsupported full metadata %j is rejected before streaming', async headers => {
  const r = await run(full(payload, headers)); expect(r.code).toBe(502); expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(Buffer.concat(r.chunks).toString()).toBe('upstream probe failed');
});
test.each([['abc', '4'], ['abcde', '4']])('full body length mismatch terminates the output (%s/%s)', async (body, length) => {
  const r = await run(full(body, { 'content-length': length })); expect(r.destroyed).toBe(true);
  expect(Buffer.concat(r.chunks).length).toBeLessThan(Number(length)); expect(global.fetch).toHaveBeenCalledTimes(1);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
test('full body streams progressively and is not cut off by the old 15-second probe timer', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  let controller; const body = new ReadableStream({ start(c) { controller = c; c.enqueue(Buffer.from('first')); } });
  global.fetch.mockResolvedValueOnce(full(body)); const r = new Output(); const pending = handle(input('bytes=2-5'), r);
  for (let i = 0; i < 20 && !r.headersSent; i++) await tick();
  expect(r.headersSent).toBe(true); expect(Buffer.concat(r.chunks).toString()).toBe('first');
  await jest.advanceTimersByTimeAsync(20000); expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(false);
  controller.enqueue(Buffer.from('second')); controller.close(); await pending;
  expect(Buffer.concat(r.chunks).toString()).toBe('firstsecond'); expect(jest.getTimerCount()).toBe(0);
});
test('client disconnect cancels the reused upstream body and its fetch signal', async () => {
  const cancelled = jest.fn(); const body = new ReadableStream({ start(c) { c.enqueue(Buffer.from('first')); }, cancel: cancelled });
  global.fetch.mockResolvedValueOnce(full(body)); const r = new Output(); const pending = handle(input('bytes=2-5'), r);
  for (let i = 0; i < 20 && !r.headersSent; i++) await tick(); expect(r.headersSent).toBe(true);
  r.destroy(); await pending; expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true); expect(cancelled).toHaveBeenCalled();
});
