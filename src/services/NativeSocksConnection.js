'use strict';

// Local integration candidate. The caller validates and pins the numeric destination;
// this connector talks exclusively to the operator-configured SOCKS proxy.
const net = require('node:net');
const { Socks5ProxyAgent, buildConnector } = require('undici');

function validateNativeProxy(value) {
  const proxy = new URL(value);
  if (!['socks:', 'socks5:'].includes(proxy.protocol)) {
    throw Object.assign(new Error('Unsupported native laboratory proxy'), { code: 'ERR_NATIVE_TUNNEL_PROXY' });
  }
  return proxy;
}

async function openNativeSocksConnection(address, { proxy, signal, track, withSignal }) {
  if (!net.isIP(address.host)) throw new TypeError('Expected a previously validated numeric destination');
  signal.throwIfAborted();
  const connect = buildConnector({});
  const agent = new Socks5ProxyAgent(proxy, {
    connect(options, callback) {
      if (signal.aborted) { callback(signal.reason); return; }
      const socket = track(connect(options, (error, connected) => {
        if (signal.aborted) { connected?.destroy(); callback(signal.reason); }
        else callback(error, connected);
      }));
      if (signal.aborted) socket.destroy();
    }
  });
  try {
    // Use Undici's handshake parser/authentication rather than introduce a
    // second SOCKS protocol implementation. No HTTP pools are created here.
    return await withSignal(agent.createSocks5Connection(address.host, address.port), signal);
  } finally { await agent.destroy(); }
}

module.exports = { validateNativeProxy, openNativeSocksConnection };
