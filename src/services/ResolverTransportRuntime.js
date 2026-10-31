'use strict';
const { createConfiguredResolverTransport } = require('./ResolverTransportConfig');

// Per-worker experimental client. Configuration errors propagate at startup;
// callers must not silently fall back to the legacy TCP resolver.
const resolverTransport = createConfiguredResolverTransport(process.env);
module.exports = { resolverTransport };
