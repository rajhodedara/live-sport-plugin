'use strict';

const { AUTH_CONFIG } = require('../config');
const createAuthRepository = require('./createAuthRepository');
const AuthService = require('./AuthService');
const PlaybackGrantService = require('./PlaybackGrantService');

let singleton = null;

function getAuthContext() {
  if (!singleton) {
    const repository = createAuthRepository(AUTH_CONFIG);
    const authService = new AuthService({ repository, config: AUTH_CONFIG });
    const playbackGrantService = new PlaybackGrantService({ repository, authService, config: AUTH_CONFIG });
    singleton = { config: AUTH_CONFIG, repository, authService, playbackGrantService };
  }
  return singleton;
}

function closeAuthContext() {
  if (singleton && singleton.repository) singleton.repository.close();
  singleton = null;
}

module.exports = { getAuthContext, closeAuthContext };
