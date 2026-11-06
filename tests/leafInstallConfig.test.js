'use strict';

const {
  resolveLeafInstallConfig,
  normalizeConfigBlob,
  extractOrigin,
  UUID_REGEX,
  PUBLIC_LEAF_ORIGINS,
} = require('../src/services/LeafInstallConfig');

// Deliberately fake identifiers: these tests never fetch an install or account.
const TOKEN = '00000000-0000-4000-8000-000000000001';
const PROFILE = 'pabc123';
const FREE_ID = `${TOKEN}.fixture`;
const FREE_ORIGIN = 'https://sports.highfly.to';
const PREMIUM_ORIGIN = 'https://premium.highfly.to';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const premium = (origin = PREMIUM_ORIGIN, profile = '') => ({
  configured: true, apiBase: `${origin}/${TOKEN}${profile ? `/${profile}` : ''}`, origin, mode: 'premium',
});

test('unconfigured installs retain the public free origin', () => {
  expect(resolveLeafInstallConfig({})).toEqual({
    configured: false, apiBase: FREE_ORIGIN, origin: FREE_ORIGIN, mode: 'free',
  });
  expect(PUBLIC_LEAF_ORIGINS).toEqual([
    FREE_ORIGIN, PREMIUM_ORIGIN, 'https://premium-us2.highfly.to', 'https://premium-eu1.highfly.to',
    'https://sports.highfly.dev', 'https://premium.highfly.dev', 'https://premium-us2.highfly.dev', 'https://premium-eu1.highfly.dev',
  ]);
  expect(Object.isFrozen(PUBLIC_LEAF_ORIGINS)).toBe(true);
});

test.each([
  ['bare free identifier', FREE_ID],
  ['free identifier with manifest suffix', `${FREE_ID}/manifest.json`],
  ['free install link', `${FREE_ORIGIN}/${FREE_ID}/manifest.json`],
  ['free JSON', JSON.stringify({ freeUserId: FREE_ID })],
  ['legacy user JSON', JSON.stringify({ userId: FREE_ID })],
])('preserves the existing %s normalization', (_label, input) => {
  const normalized = normalizeConfigBlob(input);
  const decoded = JSON.parse(Buffer.from(normalized, 'base64url').toString());
  expect(decoded.freeUserId || decoded.userId).toBe(FREE_ID);
  expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input })).toEqual({
    configured: true, apiBase: `${FREE_ORIGIN}/${normalized}`, origin: FREE_ORIGIN, mode: 'free',
  });
});

test('preserves pre-encoded free JSON, legacy free env, and install precedence', () => {
  const config = encode({ freeUserId: FREE_ID, custom: { language: 'en' } });
  expect(normalizeConfigBlob(config)).toBe(config);
  expect(resolveLeafInstallConfig({ LEAF_FREE_USER_ID: FREE_ID }).apiBase).toBe(`${FREE_ORIGIN}/${encode({ freeUserId: FREE_ID })}`);
  expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: config, LEAF_FREE_USER_ID: 'ignored' }).apiBase)
    .toBe(`${FREE_ORIGIN}/${config}`);
  expect(normalizeConfigBlob('short')).toBe('short');
  expect(normalizeConfigBlob(null)).toBe('');
});

test.each(['plain', 'encoded'])('keeps additional properties in an explicitly free %s JSON config', format => {
  const value = { freeUserId: FREE_ID, profile: 'legacy-metadata', token: 'legacy-option' };
  const input = format === 'plain' ? JSON.stringify(value) : encode(value);
  expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input })).toEqual({
    configured: true, apiBase: `${FREE_ORIGIN}/${encode(value)}`, origin: FREE_ORIGIN, mode: 'free',
  });
});

test.each([
  ['HTTPS', FREE_ORIGIN],
  ['schemeless', 'sports.highfly.to'],
  ['Stremio', 'stremio://sports.highfly.to'],
])('keeps the original free JSON blob and metadata in a %s install URL', (_format, prefix) => {
  for (const identifier of ['freeUserId', 'userId']) {
    const value = { [identifier]: FREE_ID, profile: 'legacy-metadata', token: 'legacy-option', custom: { language: 'en' } };
    const blob = encode(value);
    const input = `${prefix}/${blob}/manifest.json`;
    expect(normalizeConfigBlob(input)).toBe(blob);
    expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input }))
      .toEqual(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: blob }));
    expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input }).apiBase).toBe(`${FREE_ORIGIN}/${blob}`);
  }
});

test.each([
  ['HTTPS', FREE_ORIGIN],
  ['schemeless', 'sports.highfly.to'],
  ['Stremio', 'stremio://sports.highfly.to'],
])('rejects premium JSON extracted from a %s install URL instead of free wrapping', (_format, prefix) => {
  const blob = encode({ token: TOKEN, profile: PROFILE });
  const input = `${prefix}/${blob}/manifest.json`;
  expect(() => normalizeConfigBlob(input))
    .toThrow(expect.objectContaining({ code: 'ERR_LEAF_CONFIG', message: 'Invalid Leaf configuration' }));
  expect(() => resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input }))
    .toThrow(expect.objectContaining({ code: 'ERR_LEAF_CONFIG', message: 'Invalid Leaf configuration' }));
});

test('preserves current bare UUID premium default without free wrapping', () => {
  expect(normalizeConfigBlob(TOKEN)).toBe(TOKEN);
  expect(extractOrigin(TOKEN)).toBe(PREMIUM_ORIGIN);
  expect(UUID_REGEX.test(TOKEN)).toBe(true);
  expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: TOKEN })).toEqual(premium());
  expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: TOKEN, LEAF_API_ORIGIN: PREMIUM_ORIGIN })).toEqual(premium());
});

test.each([
  ['http://127.0.0.1:9/leaf-disabled', 'http://127.0.0.1:9'],
  ['http://127.0.0.1:9/leaf-disabled/manifest.json/', 'http://127.0.0.1:9'],
  [`${PREMIUM_ORIGIN}/${TOKEN}/${PROFILE}/manifest.json///`, PREMIUM_ORIGIN],
  ['legacy-non-url-base/manifest.json', FREE_ORIGIN],
])('whole-base override wins without validating or appending credentials: %s', (override, origin) => {
  const expected = override.replace(/\/+$/, '').replace(/\/manifest\.json$/i, '').replace(/\/+$/, '');
  expect(resolveLeafInstallConfig({
    LEAF_API_URL: override, LEAF_INSTALL_CONFIG: 'ignored', LEAF_PREMIUM_TOKEN: 'invalid', LEAF_PREMIUM_PROFILE: 'invalid',
  })).toEqual({ configured: true, apiBase: expected, origin, mode: 'override' });
});

test('retains a custom origin for legacy free installs', () => {
  expect(resolveLeafInstallConfig({ LEAF_API_ORIGIN: 'https://free-override.invalid///', LEAF_FREE_USER_ID: 'short' }))
    .toEqual({ configured: true, apiBase: 'https://free-override.invalid/short', origin: 'https://free-override.invalid', mode: 'free' });
});

test.each([
  PREMIUM_ORIGIN,
  'https://premium-us2.highfly.to',
  'https://premium-eu1.highfly.to',
  'https://premium.highfly.dev',
  'https://premium-us2.highfly.dev',
  'https://premium-eu1.highfly.dev',
])('explicit premium credentials use a direct token path on %s', origin => {
  expect(resolveLeafInstallConfig({ LEAF_PREMIUM_TOKEN: TOKEN, LEAF_API_ORIGIN: origin })).toEqual(premium(origin));
  expect(resolveLeafInstallConfig({ LEAF_PREMIUM_TOKEN: TOKEN, LEAF_PREMIUM_PROFILE: PROFILE, LEAF_API_ORIGIN: origin }))
    .toEqual(premium(origin, PROFILE));
});

test('premium token defaults to the primary premium origin and wins over legacy free settings', () => {
  expect(resolveLeafInstallConfig({ LEAF_PREMIUM_TOKEN: TOKEN, LEAF_INSTALL_CONFIG: FREE_ID, LEAF_FREE_USER_ID: 'ignored' }))
    .toEqual(premium());
});

test.each([
  TOKEN,
  `${TOKEN}/${PROFILE}`,
  `${TOKEN}/manifest.json`,
  `${TOKEN}/${PROFILE}/manifest.json`,
])('an explicitly selected premium origin accepts raw install path %s', input => {
  expect(resolveLeafInstallConfig({ LEAF_API_ORIGIN: PREMIUM_ORIGIN, LEAF_INSTALL_CONFIG: input }))
    .toEqual(premium(PREMIUM_ORIGIN, input.includes(PROFILE) ? PROFILE : ''));
});

test.each([
  `${TOKEN}/${PROFILE}`,
  `${TOKEN}/manifest.json`,
  `${TOKEN}/${PROFILE}/manifest.json`,
  `configure#${TOKEN}`,
  `configure#${TOKEN}:${PROFILE}`,
  `${PREMIUM_ORIGIN}/${TOKEN}`,
  `${PREMIUM_ORIGIN}/${TOKEN}/manifest.json`,
  `${PREMIUM_ORIGIN}/${TOKEN}/${PROFILE}/manifest.json`,
  `${PREMIUM_ORIGIN}/configure#${TOKEN}:${PROFILE}`,
  `stremio://premium.highfly.to/${TOKEN}/${PROFILE}/manifest.json`,
  `stremio://PREMIUM.HIGHFLY.TO/${TOKEN}/${PROFILE}/manifest.json`,
  `premium.highfly.to/${TOKEN}/${PROFILE}/manifest.json`,
])('recognizes a premium install without free wrapping: %s', input => {
  expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input }))
    .toEqual(premium(PREMIUM_ORIGIN, input.includes(PROFILE) ? PROFILE : ''));
});

test('full premium install links select their region and retain explicit operator origin precedence', () => {
  const origin = 'https://premium-eu1.highfly.to';
  const env = { LEAF_INSTALL_CONFIG: `${origin}/${TOKEN}/manifest.json` };
  expect(resolveLeafInstallConfig(env)).toEqual(premium(origin));
  expect(resolveLeafInstallConfig({ ...env, LEAF_API_ORIGIN: `${origin}/` })).toEqual(premium(origin));
  expect(resolveLeafInstallConfig({ LEAF_PREMIUM_TOKEN: TOKEN, LEAF_API_ORIGIN: 'HTTPS://PREMIUM.HIGHFLY.TO/' })).toEqual(premium());
  expect(resolveLeafInstallConfig({ ...env, LEAF_API_ORIGIN: 'https://premium-dedicated.highfly.to' }))
    .toEqual(premium('https://premium-dedicated.highfly.to'));
});

test.each([
  { LEAF_PREMIUM_TOKEN: 'not-a-uuid' },
  { LEAF_PREMIUM_TOKEN: `${TOKEN}suffix` },
  { LEAF_PREMIUM_TOKEN: TOKEN, LEAF_PREMIUM_PROFILE: 'pABC123' },
  { LEAF_PREMIUM_TOKEN: TOKEN, LEAF_PREMIUM_PROFILE: 'pabc12' },
  { LEAF_PREMIUM_PROFILE: PROFILE },
  { LEAF_API_ORIGIN: PREMIUM_ORIGIN },
  { LEAF_API_ORIGIN: PREMIUM_ORIGIN, LEAF_INSTALL_CONFIG: FREE_ID },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/manifest.json` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/wrong-profile/manifest.json` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/${PROFILE}/extra/manifest.json` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/manifest.json?secret=fixture` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/manifest.json#fixture` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}\n/manifest.json` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}\\manifest.json` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/bad-profile/../manifest.json` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/${PROFILE}/../?` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/${TOKEN}/${PROFILE}/../#` },
  { LEAF_INSTALL_CONFIG: `${PREMIUM_ORIGIN}/configure#${TOKEN}:` },
  { LEAF_INSTALL_CONFIG: `configure#${TOKEN}:${PROFILE}:extra` },
  { LEAF_INSTALL_CONFIG: JSON.stringify({ token: TOKEN, profile: PROFILE }) },
  { LEAF_INSTALL_CONFIG: encode({ token: TOKEN, profile: PROFILE }) },
])('rejects incomplete or malformed premium configuration without exposing input %#', env => {
  let error;
  try { resolveLeafInstallConfig(env); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: 'ERR_LEAF_CONFIG', message: 'Invalid Leaf configuration' });
  expect(String(error.stack)).not.toContain(TOKEN);
  expect(String(error.stack)).not.toContain(PROFILE);
  expect(JSON.stringify(error)).not.toContain(TOKEN);
});

test.each([
  'http://premium.highfly.to',
  'https://premium.highfly.to:443',
  'https://premium.highfly.to:444',
  'https://premium.highfly.to.evil.invalid',
  'https://premium-us3.highfly.to',
  'https://child.premium.highfly.to',
  'https://premium.highfly.to@evil.invalid',
  'https://fixture@premium.highfly.to',
  'https://premium.highfly.to/configure',
  'https://premium.highfly.to?region=fixture',
  'https://premium.highfly.to#fixture',
  'https://sports.highfly.to',
])('premium origin selection rejects non-exact origins: %s', origin => {
  expect(() => resolveLeafInstallConfig({ LEAF_PREMIUM_TOKEN: TOKEN, LEAF_API_ORIGIN: origin }))
    .toThrow(expect.objectContaining({ code: 'ERR_LEAF_CONFIG' }));
});

test.each([
  `https://premium.highfly.to.evil.invalid/${TOKEN}/manifest.json`,
  `https://premium.highfly.to@evil.invalid/${TOKEN}/manifest.json`,
  `https://fixture@premium.highfly.to/${TOKEN}/manifest.json`,
  `https://@premium.highfly.to/${TOKEN}/manifest.json`,
  `premium.highfly.to.evil.invalid/${TOKEN}/manifest.json`,
  `premium.highfly.dev@evil.invalid/${TOKEN}/manifest.json`,
])('premium link validation never re-encodes malformed credentials as free: %s', input => {
  expect(() => resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input }))
    .toThrow(expect.objectContaining({ code: 'ERR_LEAF_CONFIG' }));
});

test.each(['to', 'dev'])('retains current Highfly %s full/schemeless URLs and complete profile paths', tld => {
  for (const host of ['sports', 'premium', 'premium-us2', 'premium-eu1', 'premium-dedicated']) {
    const origin = `https://${host}.highfly.${tld}`;
    for (const input of [`${origin}/${TOKEN}/${PROFILE}/manifest.json`, `${host}.highfly.${tld}/${TOKEN}/${PROFILE}/manifest.json`]) {
      expect(normalizeConfigBlob(input)).toBe(`${TOKEN}/${PROFILE}`);
      expect(extractOrigin(input)).toBe(origin);
      expect(resolveLeafInstallConfig({ LEAF_INSTALL_CONFIG: input })).toEqual(premium(origin, PROFILE));
    }
  }
});

test('retains current root manifest and extractOrigin compatibility', () => {
  for (const input of ['manifest.json', `${FREE_ORIGIN}/manifest.json`, `${PREMIUM_ORIGIN}/manifest.json`]) {
    expect(normalizeConfigBlob(input)).toBe('');
  }
  expect(normalizeConfigBlob(`https://highfly.to/${TOKEN}`)).toBe(TOKEN);
  expect(extractOrigin(FREE_ID)).toBeNull();
  expect(extractOrigin(null)).toBeNull();
  expect(extractOrigin('not-highfly.to.invalid/fixture')).toBeNull();
  expect(extractOrigin(`${TOKEN}/${PROFILE}`)).toBe(PREMIUM_ORIGIN);
});

test('resolution follows current environment values without retaining a previous account', () => {
  const env = { LEAF_PREMIUM_TOKEN: TOKEN };
  expect(resolveLeafInstallConfig(env)).toEqual(premium());
  env.LEAF_PREMIUM_PROFILE = PROFILE;
  expect(resolveLeafInstallConfig(env)).toEqual(premium(PREMIUM_ORIGIN, PROFILE));
  delete env.LEAF_PREMIUM_TOKEN;
  delete env.LEAF_PREMIUM_PROFILE;
  expect(resolveLeafInstallConfig(env).configured).toBe(false);
});
