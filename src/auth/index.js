'use strict';

const { loadAuthConfig } = require('./authConfig');
const { AuthStore } = require('./AuthStore');
const { AuthService } = require('./AuthService');
const { createProviderRegistry } = require('./providers');

let singleton;

function hasSignInMethods({ config, service } = {}) {
  if (!config || !config.enabled || !service) return false;
  const oauthEnabled = Boolean(
    service.providers
    && typeof service.providers.list === 'function'
    && service.providers.list().length > 0
  );
  const discordEnabled = Boolean(config.discord && config.discord.enabled);
  return oauthEnabled || discordEnabled;
}

/** Lazily-built shared auth context; `service` is null when accounts are not configured. */
function getAuth(env = process.env) {
  if (singleton) return singleton;
  const config = loadAuthConfig(env);
  if (!config.enabled) {
    singleton = { config, service: null };
    return singleton;
  }
  const service = new AuthService({
    store: new AuthStore(config.dbPath), config, providers: createProviderRegistry(env),
  });
  singleton = { config, service };
  return singleton;
}

module.exports = { getAuth, hasSignInMethods };
