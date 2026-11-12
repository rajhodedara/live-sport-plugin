'use strict';

jest.mock('../src/services/ProviderOutbound', () => ({ safeFetch: (...args) => global.__leafCatalogFetch(...args) }));
const LeafProvider = require('../src/providers/LeafProvider');

const TEST_CONFIG = Buffer.from(JSON.stringify({ freeUserId: 'test-user-id.abcdef' }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const catalogOk = () => ({ ok: true, status: 200, bodyTruncated: false, json: async () => ({ metas: [] }) });
const capacityError = () => Object.assign(new Error('Native pool capacity reached'), { code: 'ERR_OUTBOUND_CAPACITY' });

function newProvider() {
  for (const key of Object.keys(process.env)) if (key.startsWith('LEAF_')) delete process.env[key];
  process.env.APP_SECRET = 'fixture-private-leaf-state-key';
  process.env.LEAF_INSTALL_CONFIG = TEST_CONFIG;
  return new LeafProvider();
}

describe('Leaf catalog capacity retry', () => {
  test('a transient capacity rejection is retried and the catalog still loads', async () => {
    const seen = [];
    global.__leafCatalogFetch = async (url, options) => {
      seen.push(options);
      if (seen.length === 1) throw capacityError();
      return catalogOk();
    };
    const provider = newProvider();
    const matches = await provider.getMatches();
    expect(seen.length).toBe(2);
    expect(provider.lastCatalogOk).toBe(true);
    expect(JSON.stringify(matches)).toBe('[]');
  });

  test('persistent capacity rejection stops after three attempts and reports the catalog as failed', async () => {
    let calls = 0;
    global.__leafCatalogFetch = async () => { calls++; throw capacityError(); };
    const provider = newProvider();
    const original = console.warn;
    console.warn = () => {};
    let matches;
    try { matches = await provider.getMatches(); } finally { console.warn = original; }
    expect(calls).toBe(3);
    expect(provider.lastCatalogOk).toBe(false);
    expect(JSON.stringify(matches)).toBe('[]');
  });

  test('other failures are not retried', async () => {
    let calls = 0;
    global.__leafCatalogFetch = async () => { calls++; throw Object.assign(new Error('boom'), { code: 'ERR_SOMETHING_ELSE' }); };
    const provider = newProvider();
    const original = console.warn;
    console.warn = () => {};
    try { await provider.getMatches(); } finally { console.warn = original; }
    expect(calls).toBe(1);
  });

  test('the catalog request is labelled for diagnostics', async () => {
    let options;
    global.__leafCatalogFetch = async (url, opts) => { options = opts; return catalogOk(); };
    await newProvider().getMatches();
    expect(options.diagnosticOwner).toBe('catalog');
  });
});
