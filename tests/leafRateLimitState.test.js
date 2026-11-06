'use strict';

const { rateLimitDelay, recordAccountRateLimit, accountCooldownRemaining, resetAccountRateLimits } =
  require('../src/services/LeafRateLimitState');
const ACCOUNT = '00000000-1111-2222-aaaa-bbbbbbbbbbbb';
const base = (host = 'premium.highfly.to', account = ACCOUNT, profile = '') =>
  `https://${host}/${account}${profile ? '/' + profile : ''}`;
let now;
beforeEach(() => {
  now = Date.parse('2026-11-06T12:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  resetAccountRateLimits();
});
afterEach(() => { resetAccountRateLimits(); jest.restoreAllMocks(); });

test('one account shares its advisory across profiles, UUID case and Highfly regions', () => {
  recordAccountRateLimit(base(), 10000);
  expect(accountCooldownRemaining(base('premium-eu1.highfly.dev', ACCOUNT.toUpperCase(), 'p123abc'))).toBe(10000);
  expect(accountCooldownRemaining(base('premium-us2.highfly.to', ACCOUNT, 'p456def'))).toBe(10000);
  expect(accountCooldownRemaining(base('premium.highfly.to', '11111111-1111-2222-aaaa-bbbbbbbbbbbb'))).toBe(0);
});

test('free JSON selectors identify the account independent of metadata and encoding', () => {
  const encoded = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  recordAccountRateLimit(base('sports.highfly.to', encoded({ freeUserId: 'fixture.account', region: 'us' })), 5000);
  expect(accountCooldownRemaining(base('sports.highfly.dev', encoded({ freeUserId: 'fixture.account', region: 'eu' })))).toBe(5000);
  expect(accountCooldownRemaining(base('sports.highfly.to', encoded({ freeUserId: 'another.account' })))).toBe(0);
});

test('custom origins have independent quotas and near-match domains do not join Highfly', () => {
  recordAccountRateLimit(base(), 10000);
  expect(accountCooldownRemaining(base('premium.highfly.to.example'))).toBe(0);
  recordAccountRateLimit(base('dedicated.example'), 2000);
  expect(accountCooldownRemaining(base('another.example'))).toBe(0);
});

test('countdown is absolute, cannot be shortened by a later hint, and expires exactly', () => {
  recordAccountRateLimit(base(), 10000);
  now += 1000;
  recordAccountRateLimit(base(), 1000);
  expect(accountCooldownRemaining(base())).toBe(9000);
  now += 9000;
  expect(accountCooldownRemaining(base())).toBe(0);
});

test('Retry-After seconds, HTTP-date, JSON countdown and hard bounds are respected', () => {
  expect(rateLimitDelay({ headers: { 'Retry-After': '10' } })).toBe(10000);
  expect(rateLimitDelay({ headers: { get: () => new Date(now + 120000).toUTCString() } })).toBe(120000);
  expect(rateLimitDelay({ headers: { 'retry-after': '5' } }, [{ title: 'Please wait 8 minutes before retrying' }])).toBe(480000);
  expect(rateLimitDelay(null, [{ name: 'Please wait 100 hours' }])).toBe(600000);
  expect(rateLimitDelay({ headers: { 'retry-after': '0' } })).toBe(1000);
  expect(rateLimitDelay({ headers: { 'retry-after': 'nonsense' } })).toBe(30000);
});

test('retained account advisories are bounded without discarding the newest', () => {
  for (let index = 0; index < 65; index++) recordAccountRateLimit(base('sports.highfly.to', `fixture-${index}`), 10000);
  expect(accountCooldownRemaining(base('sports.highfly.to', 'fixture-0'))).toBe(0);
  expect(accountCooldownRemaining(base('sports.highfly.to', 'fixture-64'))).toBe(10000);
});

test('invalid operator overrides cannot expose URL parser exceptions or account text', () => {
  expect(() => recordAccountRateLimit('invalid private selector', 2000)).not.toThrow();
  expect(accountCooldownRemaining('invalid private selector')).toBe(2000);
  expect(accountCooldownRemaining('another invalid selector')).toBe(0);
});

test('explicit full reset clears advisories', () => {
  recordAccountRateLimit(base(), 10000);
  resetAccountRateLimits();
  expect(accountCooldownRemaining(base())).toBe(0);
});
