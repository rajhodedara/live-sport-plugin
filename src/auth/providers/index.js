'use strict';

const { createGoogleProvider } = require('./google');

/**
 * Provider registry. Adding a sign-in method = add a module that returns
 * { id, label, isConfigured(), buildAuthUrl(...), exchange(...) } and list it here.
 */
const FACTORIES = [createGoogleProvider];

function createProviderRegistry(env = process.env, fetchImpl = globalThis.fetch, factories = FACTORIES) {
  const all = factories.map((f) => f(env, fetchImpl));
  const enabled = all.filter((p) => p.isConfigured());
  return {
    list: () => enabled.map((p) => ({ id: p.id, label: p.label })),
    get: (id) => enabled.find((p) => p.id === id) || null,
  };
}

module.exports = { createProviderRegistry };
