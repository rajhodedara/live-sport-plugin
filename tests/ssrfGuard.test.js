'use strict';

// Unit tests for src/services/OutboundUrlGuard.js — the SSRF gate that every
// caller-supplied URL must pass before an outbound fetch (/api/fastmp4,
// /api/mp4proxy, /api/hlschunk).
//
// Deterministic and offline: the guard accepts an injectable `resolve`, so no
// test ever performs a real DNS lookup or network call.

const fs = require('fs');
const path = require('path');
const {
  checkOutboundUrl,
  classifyAddress,
  getAllowedHosts,
  matchesAllowedHost,
  isReservedHostname,
} = require('../src/services/OutboundUrlGuard');

const publicResolver = async () => ['93.184.216.34'];
const privateResolver = async () => ['127.0.0.1'];
const mixedResolver = async () => ['93.184.216.34', '10.0.0.7'];
const failingResolver = async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); };

const reasonOf = async (url, opts) => {
  const verdict = await checkOutboundUrl(url, opts);
  return verdict.ok ? 'ALLOW' : verdict.reason;
};

describe('OutboundUrlGuard — blocked targets', () => {
  const cases = [
    ['loopback IPv4 literal', 'http://127.0.0.1:7000/health', 'blocked_address'],
    ['loopback 127.0.0.5', 'http://127.0.0.5/', 'blocked_address'],
    ['localhost hostname', 'http://localhost/x', 'blocked_host'],
    ['cloud metadata 169.254.169.254', 'http://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['RFC1918 10/8', 'http://10.0.0.5/', 'blocked_address'],
    ['RFC1918 172.16/12', 'http://172.16.0.1/', 'blocked_address'],
    ['RFC1918 192.168/16', 'http://192.168.1.1/', 'blocked_address'],
    ['CGNAT 100.64/10', 'http://100.64.0.1/', 'blocked_address'],
    ['this-network 0.0.0.0', 'http://0.0.0.0/', 'blocked_address'],
    ['IPv6 loopback ::1', 'http://[::1]:7000/', 'blocked_address'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/', 'blocked_address'],
    ['unique-local fd00::1', 'http://[fd00::1]/', 'blocked_address'],
    ['*.local suffix', 'http://printer.local/', 'blocked_host'],
    ['*.internal suffix', 'http://api.internal/', 'blocked_host'],
    ['protocol file:', 'file:///etc/passwd', 'protocol_not_allowed'],
    ['protocol ftp:', 'ftp://example.com/x', 'protocol_not_allowed'],
    ['unparseable URL', 'not a url', 'invalid_url'],
    ['empty URL', '', 'invalid_url'],
  ];

  test.each(cases)('%s is rejected', async (_label, url, expected) => {
    await expect(reasonOf(url, { resolve: publicResolver })).resolves.toBe(expected);
  });

  test('a hostname that resolves to a private address is rejected (DNS rebinding)', async () => {
    await expect(reasonOf('http://evil.example.org/', { resolve: privateResolver }))
      .resolves.toBe('blocked_address');
  });

  test('a resolver answer mixing public and private addresses is rejected', async () => {
    const verdict = await checkOutboundUrl('http://mixed.example.org/', { resolve: mixedResolver });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('blocked_address');
    expect(verdict.detail).toContain('10.0.0.7');
  });

  test('a DNS failure fails closed', async () => {
    await expect(reasonOf('http://nx.example.org/', { resolve: failingResolver }))
      .resolves.toBe('dns_resolution_failed');
  });
});

describe('OutboundUrlGuard — permitted targets', () => {
  test.each([
    ['example.com', 'http://example.com/'],
    ['ok.ru (ReplayZone MP4 CDN)', 'https://ok.ru/video/123'],
    ['cdn.jsdelivr.net (poster/img host)', 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/x.png'],
  ])('%s is permitted', async (_label, url) => {
    const verdict = await checkOutboundUrl(url, { resolve: publicResolver });
    expect(verdict.ok).toBe(true);
    expect(verdict.addresses).toEqual(['93.184.216.34']);
  });

  test('https is required to still permit the default ok.ru referer flow', async () => {
    await expect(reasonOf('https://ok.ru/video/1', { resolve: publicResolver })).resolves.toBe('ALLOW');
  });
});

describe('OutboundUrlGuard — STREAM_PROXY_ALLOWED_HOSTS', () => {
  test('unset allowlist imposes no hostname restriction', async () => {
    await expect(reasonOf('https://anything.example.com/', { allowedHosts: null, resolve: publicResolver }))
      .resolves.toBe('ALLOW');
  });

  test('exact host match is permitted', async () => {
    await expect(reasonOf('https://ok.ru/x', { allowedHosts: ['ok.ru'], resolve: publicResolver }))
      .resolves.toBe('ALLOW');
  });

  test('dot-suffix host match is permitted', async () => {
    await expect(reasonOf('https://cdn.ok.ru/x', { allowedHosts: ['ok.ru'], resolve: publicResolver }))
      .resolves.toBe('ALLOW');
  });

  test('non-allowlisted host is rejected', async () => {
    await expect(reasonOf('https://evil.com/x', { allowedHosts: ['ok.ru'], resolve: publicResolver }))
      .resolves.toBe('host_not_allowlisted');
  });

  test('suffix lookalike is not treated as a match', async () => {
    await expect(reasonOf('https://notok.ru.attacker.com/', { allowedHosts: ['ok.ru'], resolve: publicResolver }))
      .resolves.toBe('host_not_allowlisted');
  });

  test('the allowlist can never override the address checks', async () => {
    await expect(reasonOf('http://127.0.0.1:7000/x', { allowedHosts: ['127.0.0.1'], resolve: publicResolver }))
      .resolves.toBe('blocked_address');
  });

  test('getAllowedHosts parses comma lists, wildcards and a leading dot', () => {
    expect(getAllowedHosts('')).toBe(null);
    expect(getAllowedHosts('  ')).toBe(null);
    expect(getAllowedHosts('ok.ru, *.strmd.st, .example.org'))
      .toEqual(['ok.ru', 'strmd.st', 'example.org']);
  });

  test('matchesAllowedHost implements exact and dot-suffix semantics', () => {
    expect(matchesAllowedHost('ok.ru', ['ok.ru'])).toBe(true);
    expect(matchesAllowedHost('cdn.ok.ru', ['ok.ru'])).toBe(true);
    expect(matchesAllowedHost('notok.ru', ['ok.ru'])).toBe(false);
    expect(matchesAllowedHost('anything', null)).toBe(true);
  });

  test('isReservedHostname flags loopback/local names', () => {
    expect(isReservedHostname('localhost')).toBe(true);
    expect(isReservedHostname('printer.local')).toBe(true);
    expect(isReservedHostname('api.internal')).toBe(true);
    expect(isReservedHostname('ok.ru')).toBe(false);
  });
});

describe('OutboundUrlGuard — address classification', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['10.1.2.3', 'private'],
    ['192.168.5.5', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fd00::1', 'unique-local'],
  ])('%s classifies as %s', (ip, label) => {
    expect(classifyAddress(ip)).toBe(label);
  });

  test.each(['8.8.8.8', '1.1.1.1', '93.184.216.34'])('%s classifies as usable public', (ip) => {
    expect(classifyAddress(ip)).toBe(null);
  });
});

describe('streamProxy wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'streamProxy.js'),
    'utf8'
  );

  const routeOffsets = (name) => {
    const idx = source.indexOf("router.get('" + name + "'");
    expect(idx).toBeGreaterThan(-1);
    return idx;
  };

  test.each(['/api/fastmp4', '/api/mp4proxy', '/api/hlschunk'])(
    '%s runs the guard before its first outbound request',
    (route) => {
      const start = routeOffsets(route);
      // Body of this route up to the next route registration (or EOF).
      const rest = source.slice(start + 10);
      const nextRoute = rest.search(/router\.(get|post|use)\(/);
      // Strip comments first: a guard comment mentioning `client.get()` must not
      // be mistaken for a real outbound call.
      // [^\n]* rather than .* so a remaining CR does not defeat the match.
      const stripComments = (text) =>
        text
          .replace(/\r\n/g, '\n')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .map((line) => line.replace(/^\s*\/\/[^\n]*/, ''))
          .join('\n');
      const body = stripComments(nextRoute === -1 ? rest : rest.slice(0, nextRoute));

      const guardAt = body.indexOf('checkOutboundUrl(');
      expect(guardAt).toBeGreaterThan(-1);

      // The first outbound call in the handler must come after the guard.
      const outbound = ['fetch(', 'client.get(', 'http.request(', 'https.request(']
        .map((needle) => {
          const at = body.indexOf(needle);
          return at === -1 ? null : { needle, at };
        })
        .filter(Boolean)
        .sort((a, b) => a.at - b.at);

      if (outbound.length) {
        expect(guardAt).toBeLessThan(outbound[0].at);
      }

      expect(body).toContain('rejectBlockedUrl(');
    }
  );
});
