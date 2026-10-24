const { EventEmitter } = require('node:events');
jest.mock('../src/services/OutboundUrlGuard', () => ({ checkOutboundUrl: jest.fn(async () => ({ ok: true })), rejectBlockedUrl: jest.fn() }));
const guard = require('../src/services/OutboundUrlGuard');
const router = require('../src/routes/streamProxy');
const handle = router.stack.find(layer => layer.route?.path === '/api/fastmp4').route.stack[0].handle;
const data = Buffer.from('abcdefghij');
const response = (status, range, body, encoding) => new Response(body, { status, headers: {
  ...(range ? { 'content-range': range } : {}), 'content-type': 'video/mp4',
  ...(encoding ? { 'content-encoding': encoding } : {}),
} });
function req(range = 'bytes=0-3', method = 'GET') {
  return Object.assign(new EventEmitter(), { method, query: { url: 'https://fixture.example/video', concurrency: '1' }, headers: range ? { range } : {} });
}
function res() {
  const result = Object.assign(new EventEmitter(), { code: 200, headers: {}, chunks: [], headersSent: false, destroyed: false, ended: false });
  result.status = code => { result.code = code; return result; };
  result.setHeader = (key, value) => { result.headers[key.toLowerCase()] = String(value); };
  result.removeHeader = key => { delete result.headers[key.toLowerCase()]; };
  result.type = value => { result.setHeader('content-type', value); return result; };
  result.write = value => { result.headersSent = true; result.chunks.push(Buffer.from(value)); return true; };
  result.end = () => { result.headersSent = true; result.ended = true; return result; };
  result.send = value => { result.write(Buffer.from(value)); return result.end(); };
  result.destroy = () => { result.destroyed = true; };
  return result;
}
async function run(range, method) { const r = res(); await handle(req(range, method), r); return r; }
beforeEach(() => {
  guard.checkOutboundUrl.mockReset().mockResolvedValue({ ok: true }); guard.rejectBlockedUrl.mockReset();
  global.fetch = jest.fn(async (_url, options) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
    if (Number(start) >= data.length) return response(416, 'bytes */10', '');
    const last = Math.min(Number(end), data.length - 1);
    return response(206, `bytes ${start}-${last}/10`, data.subarray(Number(start), last + 1));
  });
});
test.each([
  ['bytes=0-3', 0, 3], ['bytes=6-', 6, 9], ['bytes=-3', 7, 9],
  ['bytes=-20', 0, 9], ['bytes=8-20', 8, 9], ['bytes=9-9', 9, 9],
  ['bytes=0-900719925474099200000', 0, 9], ['bytes=-900719925474099200000', 0, 9],
])('%s delivers the exact satisfiable byte window', async (range, start, end) => {
  const r = await run(range); expect(r.code).toBe(206);
  expect(r.headers['content-range']).toBe(`bytes ${start}-${end}/10`);
  expect(r.headers['content-length']).toBe(String(end - start + 1));
  expect(Buffer.concat(r.chunks)).toEqual(data.subarray(start, end + 1));
});
test.each(['bytes=10-', 'bytes=20-30', 'bytes=-0', 'bytes=5-3', 'bytes=-', 'bytes=abc-def', 'bytes=9007199254740992-'])('%s is rejected before fetching data windows', async range => {
  const r = await run(range); expect(r.code).toBe(416); expect(r.headers['content-range']).toBe('bytes */10');
  expect(r.chunks).toHaveLength(0); expect(global.fetch).toHaveBeenCalledTimes(1);
});
test.each([undefined, 'items=0-3', 'bytes=0-1,8-9'])('absent or unsupported Range %s returns full content without Content-Range', async range => {
  const r = await run(range === undefined ? '' : range); expect(r.code).toBe(200);
  expect(r.headers['content-range']).toBeUndefined(); expect(Buffer.concat(r.chunks)).toEqual(data);
});
test('HEAD ignores Range and returns full length without fetching windows', async () => {
  const r = await run('bytes=4-6', 'HEAD'); expect(r.code).toBe(200);
  expect(r.headers['content-length']).toBe('10'); expect(r.headers['content-range']).toBeUndefined();
  expect(r.chunks).toHaveLength(0); expect(global.fetch).toHaveBeenCalledTimes(1);
});
test.each([
  ['missing Content-Range', 206, null, 'a', undefined],
  ['unknown total', 206, 'bytes 0-0/*', 'a', undefined],
  ['wrong probe offset', 206, 'bytes 1-1/10', 'b', undefined],
  ['invalid total', 206, 'bytes 0-0/0', 'a', undefined],
  ['unsafe total', 206, 'bytes 0-0/9007199254740992', 'a', undefined],
  ['oversized probe body', 206, 'bytes 0-0/10', 'ab', undefined],
  ['short probe body', 206, 'bytes 0-0/10', '', undefined],
  ['encoded probe', 206, 'bytes 0-0/10', 'a', 'gzip'],
])('probe rejects %s without launching windows', async (_, status, range, body, encoding) => {
  global.fetch.mockImplementationOnce(async () => response(status, range, body, encoding));
  const r = await run('bytes=0-3'); expect(r.code).toBe(502); expect(global.fetch).toHaveBeenCalledTimes(1);
});
test.each([
  ['ignored Range 200', 200, null, 'abcdefghij', undefined],
  ['missing Content-Range', 206, null, 'abcd', undefined],
  ['wrong offset', 206, 'bytes 1-4/10', 'bcde', undefined],
  ['changed total', 206, 'bytes 0-3/11', 'abcd', undefined],
  ['wrong end', 206, 'bytes 0-4/10', 'abcde', undefined],
  ['short body', 206, 'bytes 0-3/10', 'abc', undefined],
  ['oversized body', 206, 'bytes 0-3/10', 'abcde', undefined],
  ['encoded body', 206, 'bytes 0-3/10', 'abcd', 'gzip'],
])('window rejects %s before committing partial video', async (_, status, range, body, encoding) => {
  global.fetch.mockResolvedValueOnce(response(206, 'bytes 0-0/10', 'a'))
    .mockResolvedValueOnce(response(status, range, body, encoding));
  const r = await run('bytes=0-3'); expect(r.code).toBe(502);
  expect(r.headers['content-range']).toBeUndefined(); expect(r.headers['content-length']).toBeUndefined();
  expect(Buffer.concat(r.chunks).toString()).toBe('Upstream range failed');
});
test('probe and data windows request identity encoding', async () => {
  await run('bytes=0-3'); for (const [, options] of global.fetch.mock.calls) expect(options.headers['Accept-Encoding']).toBe('identity');
});
test.each([[403,403],[404,404],[400,502]])('probe refusal %s keeps the existing client status %s',async(status,expected)=>{
  global.fetch.mockResolvedValueOnce(response(status,null,'denied'));
  const r=await run('bytes=0-3');expect(r.code).toBe(expected);expect(global.fetch).toHaveBeenCalledTimes(1);
});
test('blocked target stops before the first probe', async () => {
  const verdict = { ok: false, reason: 'blocked_address' }; guard.checkOutboundUrl.mockResolvedValue(verdict);
  const r = await run(); expect(guard.rejectBlockedUrl).toHaveBeenCalledWith(r, verdict, 'FastMP4');
  expect(global.fetch).not.toHaveBeenCalled();
});
