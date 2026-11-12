'use strict';

const { attachDiagnosticHost, createCapacityWindow, MAX_KEYS, TOP_HOSTS } = require('../src/services/CapacityDiagnostics');

const rejection = (owner, host) => ({
  code: 'ERR_NATIVE_POOL_BUSY',
  capacityDiagnostic: { limit: 4, requested: { owner, ...(host ? { host } : {}) } },
});

describe('attachDiagnosticHost', () => {
  test('adds only the hostname to the rejected request', () => {
    const failure = rejection('verify');
    attachDiagnosticHost(failure, 'cdn.example.com');
    expect(failure.capacityDiagnostic.requested.host).toBe('cdn.example.com');
    expect(JSON.stringify(failure.capacityDiagnostic)).not.toContain('http');
  });

  test('does not overwrite a host that is already there', () => {
    const failure = rejection('verify', 'first.example');
    attachDiagnosticHost(failure, 'second.example');
    expect(failure.capacityDiagnostic.requested.host).toBe('first.example');
  });

  test('truncates an absurdly long hostname', () => {
    const failure = rejection('other');
    attachDiagnosticHost(failure, 'a'.repeat(500));
    expect(failure.capacityDiagnostic.requested.host.length).toBe(120);
  });

  test('is a harmless no-op without a diagnostic or with bad input', () => {
    attachDiagnosticHost(null, 'x.example');
    attachDiagnosticHost({}, 'x.example');
    attachDiagnosticHost({ capacityDiagnostic: {} }, 'x.example');
    const failure = rejection('other');
    attachDiagnosticHost(failure, undefined);
    attachDiagnosticHost(failure, '');
    expect(failure.capacityDiagnostic.requested.host).toBe(undefined);
  });
});

describe('createCapacityWindow', () => {
  test('counts rejections by owner and host, then resets', () => {
    const w = createCapacityWindow();
    w.record(rejection('verify', 'a.example'));
    w.record(rejection('verify', 'a.example'));
    w.record(rejection('provider', 'b.example'));
    const first = w.snapshot();
    expect(first.total).toBe(3);
    expect(first.byOwner.verify).toBe(2);
    expect(first.byOwner.provider).toBe(1);
    expect(first.byHost['a.example']).toBe(2);
    const second = w.snapshot();
    expect(second.total).toBe(0);
    expect(JSON.stringify(second.byOwner)).toBe('{}');
  });

  test('reports only the busiest hosts, busiest first', () => {
    const w = createCapacityWindow();
    for (let i = 0; i < 9; i++) for (let n = 0; n <= i; n++) w.record(rejection('other', `h${i}.example`));
    const hosts = Object.keys(w.snapshot().byHost);
    expect(hosts.length).toBe(TOP_HOSTS);
    expect(hosts[0]).toBe('h8.example');
  });

  test('stays bounded under a flood of distinct keys and still counts every rejection', () => {
    const w = createCapacityWindow();
    for (let i = 0; i < MAX_KEYS * 3; i++) w.record(rejection(`owner${i}`, 'h.example'));
    const snap = w.snapshot();
    expect(snap.total).toBe(MAX_KEYS * 3);
    // Never one entry per request: the report is capped and the overflow is one bucket.
    expect(Object.keys(snap.byOwner).length).toBe(MAX_KEYS);
    expect(snap.byOwner._other).toBe(MAX_KEYS * 2);
  });

  test('a rejection without a diagnostic is counted as unknown, never thrown on', () => {
    const w = createCapacityWindow();
    w.record({ code: 'ERR_NATIVE_POOL_BUSY' });
    w.record(null);
    const snap = w.snapshot();
    expect(snap.total).toBe(2);
    expect(snap.byOwner.unknown).toBe(2);
  });

  test('hostile hostnames cannot pollute the object prototype', () => {
    const w = createCapacityWindow();
    w.record(rejection('other', '__proto__'));
    w.record(rejection('other', 'constructor'));
    const snap = w.snapshot();
    expect(snap.total).toBe(2);
    expect(({}).polluted).toBe(undefined);
  });
});
