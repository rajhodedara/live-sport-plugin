import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, get } from 'node:http';
import { spawn } from 'node:child_process';

const sourceRoot = process.env.LSP_STATIC_ROOT;
if (!sourceRoot) throw new Error('LSP_STATIC_ROOT is required');
let directory, server, port, serveStatic;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lsp-static-http-'));
  await mkdir(join(directory, 'resolver/src/http'), { recursive: true });
  await mkdir(join(directory, 'resolver/public'), { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  // Copy product bytes verbatim into an isolated real-filesystem layout.
  await copyFile(resolve(sourceRoot, 'resolver/src/http/static.js'), join(directory, 'resolver/src/http/static.js'));
  for (const file of ['index.html', 'style.css']) await writeFile(join(directory, 'resolver/public', file), 'fixture:' + file);
  await writeFile(join(directory, 'resolver/public/player.js'), 'fixture:player.js');
  ({ serveStatic } = await import(pathToFileURL(join(directory, 'resolver/src/http/static.js'))));
  server = createServer((req, res) => { if (!serveStatic(req.url, res)) { res.writeHead(404); res.end('unknown'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(async () => {
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (directory) await rm(directory, { recursive: true, force: true });
});
function request(path) {
  return new Promise((resolve, reject) => {
    const req = get({ host: '127.0.0.1', port, path, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture timeout')));
  });
}
for (const [path, file, mime] of [['/', 'index.html', 'text/html'], ['/index.html', 'index.html', 'text/html'], ['/style.css', 'style.css', 'text/css'], ['/player.js', 'player.js', 'application/javascript']]) {
  test('real filesystem/HTTP preserves ' + path, async () => {
    const result = await request(path);
    assert.equal(result.status, 200); assert.equal(result.body, 'fixture:' + file);
    assert.ok(result.headers['content-type'].startsWith(mime)); assert.equal(result.headers['cache-control'], 'no-store');
  });
}
test('unknown asset remains a router fallthrough', async () => {
  const result = await request('/unknown'); assert.equal(result.status, 404); assert.equal(result.body, 'unknown');
});
test('missing file returns 404 and the isolated server remains usable', async () => {
  // Contain the baseline unhandled ReadStream error in a disposable child, not the test runner.
  const code = `
    import { createServer, get } from 'node:http';
    import { serveStatic } from ${JSON.stringify(pathToFileURL(join(directory, 'resolver/src/http/static.js')).href)};
    const server = createServer((req, res) => serveStatic(req.url, res));
    const timeout = setTimeout(() => process.exit(2), 3000);
    server.listen(0, '127.0.0.1', async () => {
      const read = path => new Promise((resolve, reject) => {
        get({ host:'127.0.0.1', port:server.address().port, path, agent:false }, res => {
          let body=''; res.on('data', c => body += c); res.on('end', () => resolve({status:res.statusCode,body})); res.on('error', reject);
        }).on('error', reject);
      });
      try {
        const missing = await read('/player.js');
        const healthy = await read('/index.html');
        console.log(JSON.stringify({missing, healthy}));
        clearTimeout(timeout); server.closeAllConnections(); server.close();
      } catch (error) { console.error(error); process.exit(3); }
    });`;
  await rm(join(directory, 'resolver/public/player.js'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output.missing, { status: 404, body: 'not found' });
    assert.deepEqual(output.healthy, { status: 200, body: 'fixture:index.html' });
  } finally { await writeFile(join(directory, 'resolver/public/player.js'), 'fixture:player.js'); }
});
