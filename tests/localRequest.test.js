'use strict';

// Unit tests for src/services/localRequest.js — the gate that decides whether an
// internal/debug endpoint request is a DIRECT local hit or arrived through the
// public reverse proxy.
//
// This gate replaced a socket-peer check that failed in production: the reverse
// proxy runs on the same host, so every public request presented a loopback peer
// and was misclassified as local. The forwarding-header signal is what actually
// distinguishes the two.

const {
  isLocalDirectRequest,
  hasForwardingHeader,
  isPrivateOrLoopback,
  FORWARDING_HEADERS,
} = require('../src/services/localRequest');

const req = (remoteAddress, headers) => ({
  socket: { remoteAddress },
  headers: headers || {},
});

describe('hasForwardingHeader', () => {
  test('is false when no forwarding header is present', () => {
    expect(hasForwardingHeader(req('127.0.0.1'))).toBe(false);
  });

  test.each(FORWARDING_HEADERS)('is true when %s is present', (name) => {
    expect(hasForwardingHeader(req('127.0.0.1', { [name]: '203.0.113.9' }))).toBe(true);
  });

  test('ignores empty and blank values', () => {
    expect(hasForwardingHeader(req('127.0.0.1', { 'x-forwarded-for': '' }))).toBe(false);
    expect(hasForwardingHeader(req('127.0.0.1', { 'x-forwarded-for': '   ' }))).toBe(false);
    expect(hasForwardingHeader(req('127.0.0.1', { 'x-forwarded-for': [] }))).toBe(false);
  });

  test('accepts array-valued headers (repeated header)', () => {
    expect(hasForwardingHeader(req('127.0.0.1', { 'x-forwarded-for': ['10.0.0.1'] }))).toBe(true);
  });

  test('is false for a request with no headers object', () => {
    expect(hasForwardingHeader({ socket: { remoteAddress: '127.0.0.1' } })).toBe(false);
    expect(hasForwardingHeader(null)).toBe(false);
  });
});

describe('isPrivateOrLoopback', () => {
  test.each([
    '127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1',
    '10.0.0.5', '192.168.1.50', '172.16.0.1', '172.31.255.254',
  ])('%s is private or loopback', (ip) => {
    expect(isPrivateOrLoopback(ip)).toBe(true);
  });

  test.each(['8.8.8.8', '203.0.113.9', '172.32.0.1', '172.15.0.1', '193.168.1.1', ''])
    ('%s is not private or loopback', (ip) => {
      expect(isPrivateOrLoopback(ip)).toBe(false);
    });
});

describe('isLocalDirectRequest', () => {
  test('direct hit from loopback with no forwarding header is local', () => {
    expect(isLocalDirectRequest(req('127.0.0.1'))).toBe(true);
  });

  test('direct hit from a LAN address with no forwarding header is local', () => {
    expect(isLocalDirectRequest(req('192.168.1.50'))).toBe(true);
    expect(isLocalDirectRequest(req('::ffff:192.168.1.50'))).toBe(true);
  });

  test('a proxied request is NOT local even though the socket peer is loopback', () => {
    // This is the exact production failure mode the gate exists to prevent.
    expect(isLocalDirectRequest(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
  });

  test.each(FORWARDING_HEADERS)(
    'presence of %s alone disqualifies a loopback peer',
    (name) => {
      expect(isLocalDirectRequest(req('127.0.0.1', { [name]: '203.0.113.9' }))).toBe(false);
    }
  );

  test('a public socket peer is never local', () => {
    expect(isLocalDirectRequest(req('93.184.216.34'))).toBe(false);
    expect(isLocalDirectRequest(req('::ffff:93.184.216.34'))).toBe(false);
  });

  test('a missing socket address is not local', () => {
    expect(isLocalDirectRequest({ headers: {} })).toBe(false);
    expect(isLocalDirectRequest(null)).toBe(false);
  });
});

describe('index.js wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');

  test('both internal endpoints use the local-direct gate', () => {
    const serverInfo = src.slice(src.indexOf("app.get('/api/server-info'"));
    const matches = src.slice(src.indexOf("app.get('/api/matches'"));
    expect(serverInfo).toContain('isLocalDirectRequest(req)');
    expect(matches).toContain('isLocalDirectRequest(req)');
    expect(matches).toContain('loopback_only');
  });

  test('the ineffective socket-peer helper is gone', () => {
    expect(src).not.toContain('isLoopbackRequest');
  });
});
