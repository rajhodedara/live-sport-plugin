
// These tests explicitly exercise the unauthenticated TCP compatibility mode.
const legacyTrustBeforeTests = process.env.RESOLVER_TRUST_LEGACY_TCP;
beforeAll(() => { process.env.RESOLVER_TRUST_LEGACY_TCP = 'true'; });
afterAll(() => {
  if (legacyTrustBeforeTests === undefined) delete process.env.RESOLVER_TRUST_LEGACY_TCP;
  else process.env.RESOLVER_TRUST_LEGACY_TCP = legacyTrustBeforeTests;
});
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('slow-mint recovery crosses the real worker, HTTP router and resolver cache on loopback', () => {
  // Load the actual router with its provider-resolution and static-file imports
  // replaced at the ESM boundary. No provider module or provider I/O is loaded.
  const result = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', `
    import { readFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    import { SourceTextModule, SyntheticModule } from 'node:vm';
    import { createRequire } from 'node:module';
    import * as cacheModule from './resolver/src/cache.js';
    let now = 100000; Date.now = () => now;
    const source = readFileSync('./resolver/src/http/router.js', 'utf8');
    const router = new SourceTextModule(source);
    await router.link(async name => {
      if (name === '../cache.js') {
        return new SyntheticModule(Object.keys(cacheModule), function () {
          for (const [key, value] of Object.entries(cacheModule)) this.setExport(key, value);
        });
      }
      if (name === '../resolve/run.js') return new SyntheticModule(['run'], function () {
        this.setExport('run', async () => { throw Error('Provider resolution forbidden in this fixture'); });
      });
      if (name === './static.js') return new SyntheticModule(['serveStatic'], function () {
        this.setExport('serveStatic', () => false);
      });
      throw Error('Unexpected router dependency: ' + name);
    });
    await router.evaluate();
    const server = createServer(router.namespace.route);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const nativeFetch = global.fetch, calls = [];
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.origin !== base) throw Error('Non-fixture network request forbidden');
      calls.push({ method: options.method || 'GET', vacant: parsed.searchParams.get('vacant') === '1' });
      return nativeFetch(url, options);
    };
    process.env.RESOLVER_PORT = String(server.address().port);
    process.env.RESOLVE_CACHE_SHARED = 'true';
    process.env.RESOLVER_TRUST_LEGACY_TCP = 'true';
    const require = createRequire(import.meta.url);
    const StreamResolveCache = require('./src/services/StreamResolveCache');
    try {
      const key = 'provider:http-slow:source';
      const first = await new StreamResolveCache().getOrCreate(key, async () => {
        now += 31000; return [{ url: 'synthetic' }];
      });
      let duplicateMint = false;
      const second = await new StreamResolveCache().getOrCreate(key, async () => { duplicateMint = true; return []; });
      const occupied = await (await global.fetch(base + '/api/cache/' + encodeURIComponent(key) + '?claim=1&fenced=1&vacant=1')).json();
      process.stdout.write(JSON.stringify({ first, second, duplicateMint, occupied, calls, stats: cacheModule.cacheStats() }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(result.first).toEqual([{ url: 'synthetic' }]);
  expect(result.second).toEqual(result.first);
  expect(result.duplicateMint).toBe(false);
  expect(result.occupied).toEqual({ ok: false, reason: 'cache-present' });
  expect(result.calls.filter(call => call.method === 'POST')).toHaveLength(2);
  expect(result.stats.claims).toBe(0);
});
