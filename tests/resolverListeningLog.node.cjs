'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('listening callback handles inherited sockets and TCP addresses', async () => {
  const { logListeningAddress } = await import('../resolver/src/listeningLog.js');
  for (const [address, expected] of [
    [null, '[Resolver] Activated socket is listening'],
    ['/run/resolver.sock', '[Resolver] Activated socket is listening'],
    [{ address: '127.0.0.1', port: 3000 }, 'http://127.0.0.1:3000/'],
    [{ address: '::1', port: 3000 }, 'http://[::1]:3000/']
  ]) {
    const messages = [];
    logListeningAddress({ address: () => address }, message => messages.push(message));
    assert.deepEqual(messages, [expected]);
  }
});
