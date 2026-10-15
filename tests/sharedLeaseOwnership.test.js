const { execFileSync } = require('child_process');
const path = require('path');
function run(body) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { cacheClaim, cacheGet, cacheSet, cacheDelete } from './resolver/src/cache.js';
    let now = 100000; Date.now = () => now;
    const key = 'provider:match:source';
    ${body}
  `], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 }));
}

describe('Shared cache lease ownership', () => {
  test.each(['ok', 'failed'])('an expired owner cannot overwrite a newer published result (%s)', status => {
    const result = run(`
      const a = cacheClaim(key, 5000, true);
      now += 5000;
      const b = cacheClaim(key, 5000, true);
      cacheSet(key, [{ url: 'new' }], 60000, 'ok', b.ownerToken);
      const late = cacheSet(key, ${status === 'ok' ? "[{ url: 'old' }]" : '[]'}, 60000, '${status}', a.ownerToken);
      console.log(JSON.stringify({ late, current: cacheGet(key) }));
    `);
    expect(result.late.ok).toBe(false);
    expect(result.current.status).toBe('ok');
    expect(result.current.streams).toEqual([{ url: 'new' }]);
  });

  test('an expired owner cannot delete a newer result after its provider fails late', () => {
    const result = run(`
      const a = cacheClaim(key, 5000, true); now += 5000;
      const b = cacheClaim(key, 5000, true);
      cacheSet(key, [{ url: 'new' }], 60000, 'ok', b.ownerToken);
      const late = cacheDelete(key, a.ownerToken);
      console.log(JSON.stringify({ late, current: cacheGet(key) }));
    `);
    expect(result.late.ok).toBe(false);
    expect(result.current.streams).toEqual([{ url: 'new' }]);
  });

  test('a stale release cannot remove another worker’s active claim', () => {
    const result = run(`
      const a = cacheClaim(key, 5000, true); now += 5000;
      const b = cacheClaim(key, 5000, true);
      const late = cacheDelete(key, a.ownerToken);
      console.log(JSON.stringify({ late, current: cacheGet(key), duplicate: cacheClaim(key, 5000, true) }));
    `);
    expect(result.late.ok).toBe(false);
    expect(result.current.status).toBe('minting');
    expect(result.duplicate.ok).toBe(false);
  });

  test('fenced reservations require their owner token for publication and release', () => {
    const result = run(`
      const owner = cacheClaim(key, 5000, true);
      const write = cacheSet(key, [{ url: 'unowned' }], 60000);
      const release = cacheDelete(key);
      console.log(JSON.stringify({ token: owner.ownerToken, write, release, current: cacheGet(key) }));
    `);
    expect(typeof result.token).toBe('string');
    expect(result.write.ok).toBe(false);
    expect(result.release.ok).toBe(false);
    expect(result.current.status).toBe('minting');
  });

  test('current owners can publish or release, and reacquisition gets a fresh token', () => {
    const result = run(`
      const a = cacheClaim(key, 5000, true);
      const release = cacheDelete(key, a.ownerToken);
      const b = cacheClaim(key, 5000, true);
      const write = cacheSet(key, [{ url: 'new' }], 60000, 'ok', b.ownerToken);
      console.log(JSON.stringify({ a, b, release, write, current: cacheGet(key) }));
    `);
    expect(typeof result.a.ownerToken).toBe('string');
    expect(result.b.ownerToken).not.toBe(result.a.ownerToken);
    expect(result.release.ok).toBe(true);
    expect(result.write.ok).toBe(true);
    expect(result.current.streams).toEqual([{ url: 'new' }]);
  });

  test('legacy unfenced claim/write/delete behavior remains supported', () => {
    const result = run(`
      const claim = cacheClaim(key);
      const write = cacheSet(key, [{ url: 'legacy' }], 60000);
      const current = cacheGet(key);
      const release = cacheDelete(key);
      console.log(JSON.stringify({ claim, write, current, release, after: cacheGet(key) }));
    `);
    expect(result.claim.ok).toBe(true);
    expect(result.write.ok).toBe(true);
    expect(result.current.streams).toEqual([{ url: 'legacy' }]);
    expect(result.release.ok).toBe(true);
    expect(result.after.status).toBe('miss');
  });
});
