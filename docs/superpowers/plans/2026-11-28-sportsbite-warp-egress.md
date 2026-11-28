# SportsBite WARP Egress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `sportsbite.org` (and its subdomains) through `WARP_PROXY_URL` in the guarded egress policy so `SportsBiteProvider` and `/api/manifest` bypass the VPS IP `403 Forbidden` block.

**Architecture:** `SportsBiteProvider` and `/api/manifest` both send external requests through `SharedOutboundFetch`, which delegates proxy and TLS profile selection to `GuardedEgressPolicy.selectGuardedEgress`. Adding `isSportsbiteTarget(url)` alongside `isDamitvTarget(url)` in `src/services/GuardedEgressPolicy.js` routes all `sportsbite.org` catalog, embed, and playlist requests through `WARP_PROXY_URL` without modifying provider or route code.

**Tech Stack:** Node >= 22 (CommonJS), Jest (`npm test -- <path>`), `ncc` build (`npm run build`).

**Spec:** User investigation on 2026-11-28 (`https://sportsbite.org/api/forestgump/matches` returns `403 Forbidden` from VPS direct IP `192.236.184.122`, `200 OK` via `WARP_PROXY_URL=socks5://127.0.0.1:40000`).

## Global Constraints

- Node >= 22, CommonJS (`'use strict'`).
- **I10 / D8:** All external requests go through the guarded egress stack (`GuardedEgressPolicy` -> `SharedOutboundFetch`).
- **I7:** Never hand-edit `dist/`; edit `src/` and verify with `npm run build` + `node --check dist.next/index.js`.
- Use `npm test -- <path>` (not `npx jest`).

## Review Focus

- `sportsbite.org` subdomain matching (`www.sportsbite.org`, `cdn.sportsbite.org`) must match, while unrelated lookalike domains (`notsportsbite.org`, `sportsbite.org.evil.com`) must not.
- `DAMITV_PROXY_URL` must NOT be used as a fallback proxy for `sportsbite.org` (only `WARP_PROXY_URL` applies).
- When `WARP_PROXY_URL` is unset, `sportsbite.org` must fall back to `proxyUrl: null` and `profile: 'chrome'` (unlike `damitv.st`, which forces `vanilla`).
- Explicit `options.proxyUrl: null` must override `WARP_PROXY_URL` for `sportsbite.org` (preserving caller direct-egress opt-out).
- Proxy `403` or proxy handshake failure for `sportsbite.org` must not escape to direct fallback in `SharedOutboundFetch`.

---

### Task 1: Route `sportsbite.org` through `WARP_PROXY_URL` in `GuardedEgressPolicy`

**Files:**
- Modify: `src/services/GuardedEgressPolicy.js:15-36`
- Test: `tests/sharedOutboundPolicy.test.js`

**Interfaces:**
- Consumes: `hostnameOf(value, rejectUserinfo)` in `src/services/GuardedEgressPolicy.js`
- Produces: `isSportsbiteTarget(value: string | URL) -> boolean`, updated `selectGuardedEgress(url, options, environment) -> { proxyUrl: string | null, profile: string }`

- [ ] **Step 1: Write the failing tests in `tests/sharedOutboundPolicy.test.js`**

Add tests covering `isSportsbiteTarget` and `selectGuardedEgress` / `createSharedOutboundFetch` for `sportsbite.org`:

```js
const { isSportsbiteTarget, selectGuardedEgress } = require('../src/services/GuardedEgressPolicy');

test('routes sportsbite.org and subdomains through WARP_PROXY_URL when configured', () => {
  process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:40000';
  expect(isSportsbiteTarget('https://sportsbite.org/api/forestgump/matches')).toBe(true);
  expect(isSportsbiteTarget('https://cdn.sportsbite.org/selfhost/embed/s-1')).toBe(true);
  expect(isSportsbiteTarget('https://notsportsbite.org/')).toBe(false);
  expect(isSportsbiteTarget('https://sportsbite.org.evil.com/')).toBe(false);

  expect(selectGuardedEgress('https://sportsbite.org/api/forestgump/matches')).toEqual({
    proxyUrl: 'socks5://127.0.0.1:40000',
    profile: 'vanilla'
  });
});

test('sportsbite.org ignores DAMITV_PROXY_URL, uses chrome when WARP_PROXY_URL is unset, and honors explicit proxyUrl: null', () => {
  delete process.env.WARP_PROXY_URL;
  const prevDamitv = process.env.DAMITV_PROXY_URL;
  process.env.DAMITV_PROXY_URL = 'socks5://127.0.0.1:40001';
  try {
    expect(selectGuardedEgress('https://sportsbite.org/api/forestgump/matches')).toEqual({
      proxyUrl: null,
      profile: 'chrome'
    });
    process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:40000';
    expect(selectGuardedEgress('https://sportsbite.org/api/forestgump/matches', { proxyUrl: null })).toEqual({
      proxyUrl: null,
      profile: 'chrome'
    });
  } finally {
    if (prevDamitv === undefined) delete process.env.DAMITV_PROXY_URL;
    else process.env.DAMITV_PROXY_URL = prevDamitv;
  }
});

test('sportsbite.org proxy 403 does not escape via direct fallback', async () => {
  process.env.WARP_PROXY_URL = 'socks5://127.0.0.1:40000';
  const nativeFetch = jest.fn(async () => result(403));
  const fallbackFetch = jest.fn();
  const fetch = createSharedOutboundFetch({ nativeFetch, fallbackFetch });
  expect((await fetch('https://sportsbite.org/api/forestgump/matches')).status).toBe(403);
  expect(nativeFetch.mock.calls[0][1]).toMatchObject({
    profile: 'vanilla',
    proxyUrl: 'socks5://127.0.0.1:40000'
  });
  expect(fallbackFetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/sharedOutboundPolicy.test.js`
Expected: FAIL (`isSportsbiteTarget is not a function` and `selectGuardedEgress` returns `proxyUrl: null, profile: 'chrome'` instead of `WARP_PROXY_URL`).

- [ ] **Step 3: Implement `isSportsbiteTarget` and update `selectGuardedEgress` in `src/services/GuardedEgressPolicy.js`**

- Add `isSportsbiteTarget(value)` returning `host === 'sportsbite.org' || host.endsWith('.sportsbite.org')`.
- In `selectGuardedEgress(url, options = {}, environment = process.env)`:
  - Compute `const sportsbite = isSportsbiteTarget(url);`
  - Compute `const configuredProxy = dami ? (environment.WARP_PROXY_URL || environment.DAMITV_PROXY_URL) : (sportsbite ? environment.WARP_PROXY_URL : null);`
  - Keep `const profile = options.profile || (proxyUrl || dami ? 'vanilla' : 'chrome');`
- Export `isSportsbiteTarget` in `module.exports`.

- [ ] **Step 4: Run tests and build verification**

Run: `npm test -- tests/sharedOutboundPolicy.test.js && npm test -- tests/sportsBiteProvider.test.js && npm run build && node --check dist.next/index.js`
Expected: All tests in `tests/sharedOutboundPolicy.test.js` and `tests/sportsBiteProvider.test.js` PASS, and `dist.next/index.js` passes `node --check`.

- [ ] **Step 5: Commit**

```bash
git add src/services/GuardedEgressPolicy.js tests/sharedOutboundPolicy.test.js
git commit -m "fix(egress): route sportsbite.org through WARP_PROXY_URL"
```
