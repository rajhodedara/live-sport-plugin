const fs = require('fs'), path = require('path'), vm = require('vm');
const { EventEmitter } = require('events');
function fixture() {
  const stream = new EventEmitter(); stream.pipe = jest.fn(); stream.destroy = jest.fn();
  const res = new EventEmitter();
  Object.assign(res, { headersSent: false, destroyed: false, writableEnded: false });
  res.writeHead = jest.fn(() => { res.headersSent = true; });
  res.end = jest.fn(() => { res.writableEnded = true; });
  res.destroy = jest.fn(() => { res.destroyed = true; res.emit('close'); });
  const createReadStream = jest.fn(() => stream);
  // ESM source adapter replaces import bindings and import.meta only; function logic is unchanged.
  let source = fs.readFileSync(path.join(__dirname, '../resolver/src/http/static.js'), 'utf8');
  source = source.replace(/^import .*\n/gm, '').replace(/import\.meta\.url/g, "'file:///fixture/resolver/src/http/static.js'").replace('export function serveStatic', 'function serveStatic');
  const context = { createReadStream, dirname: path.dirname, join: path.join, fileURLToPath: require('url').fileURLToPath };
  vm.createContext(context); vm.runInContext(source, context);
  return { res, stream, createReadStream, serveStatic: context.serveStatic };
}
test.each(['ENOENT', 'ENOTDIR'])('%s becomes a handled 404 before headers', code => {
  const f = fixture(); expect(f.serveStatic('/player.js', f.res)).toBe(true);
  expect(() => f.stream.emit('error', Object.assign(new Error('/private/path'), { code }))).not.toThrow();
  expect(f.res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  expect(f.res.end).toHaveBeenCalledWith('not found'); expect(f.stream.pipe).not.toHaveBeenCalled();
});
test('unreadable file becomes a generic 500 before headers', () => {
  const f = fixture(); f.serveStatic('/player.js', f.res);
  expect(() => f.stream.emit('error', Object.assign(new Error('/private/path'), { code: 'EACCES' }))).not.toThrow();
  expect(f.res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
  expect(f.res.end).toHaveBeenCalledWith('unable to read asset');
});
test('a late read error closes the partial response without a second status', () => {
  const f = fixture(); f.serveStatic('/player.js', f.res); f.stream.emit('open', 17);
  expect(() => f.stream.emit('error', new Error('read failed'))).not.toThrow();
  expect(f.res.destroy).toHaveBeenCalledTimes(1); expect(f.res.writeHead).toHaveBeenCalledTimes(1); expect(f.res.end).not.toHaveBeenCalled();
});
test.each(['close', 'error'])('response %s destroys the file stream', event => {
  const f = fixture(); f.serveStatic('/player.js', f.res);
  if (event === 'close') f.res.destroyed = true;
  expect(() => f.res.emit(event, new Error('fixture connection closed'))).not.toThrow();
  expect(f.stream.destroy).toHaveBeenCalled();
});
test('already closed response never pipes an opened file', () => {
  const f = fixture(); f.res.destroyed = true; f.serveStatic('/player.js', f.res); f.stream.emit('open', 17);
  expect(f.stream.destroy).toHaveBeenCalled(); expect(f.stream.pipe).not.toHaveBeenCalled(); expect(f.res.writeHead).not.toHaveBeenCalled();
});
test('file error after client close is consumed without replying', () => {
  const f = fixture(); f.serveStatic('/player.js', f.res); f.res.destroy();
  expect(() => f.stream.emit('error', new Error('cancelled read'))).not.toThrow(); expect(f.res.writeHead).not.toHaveBeenCalled();
});
test('file close removes response cleanup listeners', () => {
  const f = fixture(); f.serveStatic('/player.js', f.res); f.stream.emit('close');
  expect(f.res.listenerCount('close')).toBe(0); expect(f.res.listenerCount('error')).toBe(0);
});
test.each([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ['/player.js', 'player.js', 'application/javascript; charset=utf-8'],
])('successful %s keeps its asset and MIME', (route, file, mime) => {
  const f = fixture(); expect(f.serveStatic(route, f.res)).toBe(true); f.stream.emit('open', 17);
  expect(f.createReadStream).toHaveBeenCalledWith('/fixture/resolver/public/' + file);
  expect(f.res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
  expect(f.stream.pipe).toHaveBeenCalledWith(f.res);
});
test('unknown path falls through without creating a stream', () => {
  const f = fixture(); expect(f.serveStatic('/unknown', f.res)).toBe(false);
  expect(f.createReadStream).not.toHaveBeenCalled(); expect(f.res.writeHead).not.toHaveBeenCalled();
});
