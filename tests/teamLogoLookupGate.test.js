'use strict';

process.env.TEAM_LOGOS_CACHE_FILE = require('path').join(require('os').tmpdir(), `nuvio-logo-test-${process.pid}.json`);
jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: (...args) => global.__logoFetch(...args) }));

const TeamLogoService = require('../src/services/TeamLogoService');
const { createLookupGate } = require('../src/services/OutboundLookupGate');

const json = (body, init = {}) => ({ ok: true, status: 200, json: async () => body, ...init });
const found = (badge) => json({ teams: [{ strTeam: 'x', strBadge: badge }] });
const capacityError = () => Object.assign(new Error('Native pool capacity reached'), { code: 'ERR_OUTBOUND_CAPACITY' });

function newService(now) {
  const svc = new TeamLogoService();
  clearInterval(svc._sweepTimer);
  if (now) svc._lookupGate = createLookupGate({ now, concurrency: 2, maxQueue: 50 });
  return svc;
}
const clock = () => { let t = Date.now(); const now = () => t; now.advance = (ms) => { t += ms; }; return now; };

describe('TeamLogoService lookups', () => {
  test('a successful lookup is cached and labelled "logo" for the pool diagnostics', async () => {
    const calls = [];
    global.__logoFetch = async (url, options) => { calls.push(options); return found('https://img/zzyzx.png'); };
    const svc = newService();
    expect(await svc.findTeamLogo('Zzyzx Rovers')).toBe('https://img/zzyzx.png');
    expect(await svc.findTeamLogo('Zzyzx Rovers')).toBe('https://img/zzyzx.png');
    expect(calls.length).toBe(1);
    expect(calls[0].diagnosticOwner).toBe('logo');
  });

  test('a genuine miss (200, no team) is cached for hours, not minutes', async () => {
    let n = 0;
    global.__logoFetch = async () => { n++; return json({ teams: null }); };
    const svc = newService();
    expect(await svc.findTeamLogo('Qwxyz Nobody United')).toBe(null);
    expect(await svc.findTeamLogo('Qwxyz Nobody United')).toBe(null);
    expect(n).toBe(1);
    const entry = [...svc.cache.values()].find(e => e && e.url === null);
    const ttl = entry.expiresAt - Date.now();
    expect(ttl > 60 * 60 * 1000).toBe(true);
  });

  test('a pool refusal is NOT cached as a miss, and stops further lookups instead of repeating them', async () => {
    let n = 0;
    global.__logoFetch = async () => { n++; throw capacityError(); };
    const svc = newService();
    expect(await svc.findTeamLogo('Aaa One')).toBe(null);
    expect(n).toBe(1);
    expect([...svc.cache.values()].some(e => e && e.url === null)).toBe(false);   // not a negative entry
    // same key and different keys: no more network while backed off / breaker open
    expect(await svc.findTeamLogo('Aaa One')).toBe(null);
    expect(await svc.findTeamLogo('Bbb Two')).toBe(null);
    expect(await svc.findTeamLogo('Ccc Three')).toBe(null);
    expect(n).toBe(1);
  });

  test('429, 403 and 5xx also open the breaker; an ordinary 404 only backs off that key', async () => {
    for (const status of [429, 403, 503]) {
      let n = 0;
      global.__logoFetch = async () => { n++; return { ok: false, status }; };
      const svc = newService();
      await svc.findTeamLogo(`Team A ${status}`);
      await svc.findTeamLogo(`Team B ${status}`);
      expect(n).toBe(1);
    }
    let m = 0;
    global.__logoFetch = async () => { m++; return { ok: false, status: 404 }; };
    const svc = newService();
    await svc.findTeamLogo('Team A 404');
    await svc.findTeamLogo('Team B 404');
    expect(m).toBe(2);
  });

  test('it recovers: after the breaker window a lookup goes out again and succeeds', async () => {
    const now = clock();
    let healthy = false, n = 0;
    global.__logoFetch = async () => { n++; if (!healthy) throw capacityError(); return found('https://img/ok.png'); };
    const svc = newService(now);
    expect(await svc.findTeamLogo('Recover FC')).toBe(null);
    expect(await svc.findTeamLogo('Recover FC')).toBe(null);
    expect(n).toBe(1);
    healthy = true;
    now.advance(10 * 60 * 1000);
    expect(await svc.findTeamLogo('Recover FC')).toBe('https://img/ok.png');
    expect(n).toBe(2);
  });

  test('an unreadable 200 body is retried later, not recorded as a miss', async () => {
    global.__logoFetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    const svc = newService();
    expect(await svc.findTeamLogo('Garbled Town')).toBe(null);
    expect([...svc.cache.values()].some(e => e && e.url === null)).toBe(false);
  });

  test('never more than the concurrency cap in flight, however many names are asked for', async () => {
    let inFlight = 0, peak = 0;
    global.__logoFetch = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 15));
      inFlight--;
      return found('https://img/x.png');
    };
    const svc = newService();
    await Promise.all(Array.from({ length: 12 }, (_, i) => svc.findTeamLogo(`Concurrent Club ${i}`)));
    expect(peak <= 2).toBe(true);
    expect(peak).toBe(2);
  });

  test('concurrent requests for the same name share one lookup', async () => {
    let n = 0;
    global.__logoFetch = async () => { n++; await new Promise(r => setTimeout(r, 10)); return found('https://img/same.png'); };
    const svc = newService();
    const out = await Promise.all([1, 2, 3, 4].map(() => svc.findTeamLogo('Shared Name SC')));
    expect(n).toBe(1);
    expect(out.join(',')).toBe(Array(4).fill('https://img/same.png').join(','));
  });
});
