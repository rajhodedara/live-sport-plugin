'use strict';

class AuthRepository {
  createUser() { throw new Error('createUser() not implemented'); }
  findUserByEmail() { throw new Error('findUserByEmail() not implemented'); }
  findUserById() { throw new Error('findUserById() not implemented'); }
  recordLoginFailure() { throw new Error('recordLoginFailure() not implemented'); }
  resetLoginFailures() { throw new Error('resetLoginFailures() not implemented'); }
  createSession() { throw new Error('createSession() not implemented'); }
  findSessionByTokenHash() { throw new Error('findSessionByTokenHash() not implemented'); }
  findSessionById() { throw new Error('findSessionById() not implemented'); }
  deleteSessionByTokenHash() { throw new Error('deleteSessionByTokenHash() not implemented'); }
  createDeviceToken() { throw new Error('createDeviceToken() not implemented'); }
  listDeviceTokens() { throw new Error('listDeviceTokens() not implemented'); }
  findDeviceByTokenHash() { throw new Error('findDeviceByTokenHash() not implemented'); }
  findDeviceById() { throw new Error('findDeviceById() not implemented'); }
  touchDeviceToken() { throw new Error('touchDeviceToken() not implemented'); }
  revokeDeviceToken() { throw new Error('revokeDeviceToken() not implemented'); }
  deleteDeviceToken() { throw new Error('deleteDeviceToken() not implemented'); }
  close() {}
}

module.exports = AuthRepository;
