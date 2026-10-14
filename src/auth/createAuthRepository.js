'use strict';

const SQLiteAuthRepository = require('./SQLiteAuthRepository');

function createAuthRepository(config) {
  const driver = String(config.dbDriver || 'sqlite').toLowerCase();
  if (driver === 'sqlite') {
    return new SQLiteAuthRepository({ filename: config.dbPath });
  }
  throw new Error(`Unsupported AUTH_DB_DRIVER "${driver}". Available drivers: sqlite`);
}

module.exports = createAuthRepository;
