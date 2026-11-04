'use strict';
// Fail a selected offline test immediately if it starts real workers or sockets.
require('node:worker_threads').Worker = class {
  constructor() { throw new Error('PR59_OFFLINE_WORKER_BLOCKED'); }
};
require('node:net').Socket.prototype.connect = function () {
  throw new Error('PR59_OFFLINE_NETWORK_BLOCKED');
};
require('node:net').Server.prototype.listen = function () {
  throw new Error('PR59_OFFLINE_LISTENER_BLOCKED');
};
