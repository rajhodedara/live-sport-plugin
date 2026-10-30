'use strict';
const { filterRedirectHeaders, shouldDropRedirectBody } = require('../src/services/RedirectHeaderPolicy');
test.each([
  { 'X-Api-Key': 'secret', AUTHORIZATION: 'secret', 'User-Agent': 'client', Range: 'bytes=0-1', Referer: 'https://private.example/path?token=secret' },
  new Headers({ 'X-Api-Key': 'secret', AUTHORIZATION: 'secret', 'User-Agent': 'client', Range: 'bytes=0-1', Referer: 'https://private.example/path?token=secret' }),
  ['X-Api-Key', 'secret', 'AUTHORIZATION', 'secret', 'User-Agent', 'client', 'Range', 'bytes=0-1', 'Referer', 'https://private.example/path?token=secret']
])('allows only explicit non-custom headers after cross-origin redirect', input => {
  const filtered = filterRedirectHeaders(input);
  const result = new Headers(Array.isArray(filtered) ? Array.from({ length: filtered.length / 2 }, (_, i) => filtered.slice(i * 2, i * 2 + 2)) : filtered);
  expect(result.get('x-api-key')).toBeNull(); expect(result.get('authorization')).toBeNull(); expect(result.get('referer')).toBeNull();
  expect(result.get('user-agent')).toBe('client'); expect(result.get('range')).toBe('bytes=0-1');
});
test.each([[301,'POST',true],[302,'PUT',false],[303,'PUT',true],[303,'HEAD',false],[307,'POST',false],[308,'POST',false]])('redirect %i %s body conversion', (status, method, expected) => {
  expect(shouldDropRedirectBody(status, method)).toBe(expected);
});
