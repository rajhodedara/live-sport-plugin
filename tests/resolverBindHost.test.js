'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const envPath = path.join(__dirname, '..', 'resolver', 'src', 'env.js');
const serverPath = path.join(__dirname, '..', 'resolver', 'src', 'server.js');

function readBindHost(host) {
  const env = { ...process.env };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;

  // Evaluate ESM env.js in a fresh process so the module cache cannot carry
  // one test's HOST into another test. No ports or external network involved.
  const expr = 'import { bindHost } from ' + JSON.stringify(pathToFileURL(envPath).href)
    + '; console.log(JSON.stringify(bindHost))';
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', expr], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  }).trim());
}

function listenAddress(host) {
  const env = { ...process.env };
  delete env.HOST;
  if (host !== undefined) env.HOST = host;
  // Execute the real server entrypoint with the real HTTP implementation and
  // env.js HOST selection. Only its port is replaced with 0 and the provider
  // router with a status-only handler, so no provider module/I/O is loaded.
  const expression = `
    import { readFileSync } from 'node:fs';
    import { createServer, get } from 'node:http';
    import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
    import { bindHost } from ${JSON.stringify(pathToFileURL(envPath).href)};
    const context = createContext({ process, console: { log() {}, error() {} } });
    let server, ready;
    const module = new SourceTextModule(readFileSync(${JSON.stringify(serverPath)}, 'utf8'), { context });
    await module.link(async name => {
      if (name === 'node:http') return new SyntheticModule(['createServer'], function () {
        this.setExport('createServer', (...args) => {
          server = createServer(...args);
          ready = new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
          return server;
        });
      }, { context });
      if (name === 'node:https') return new SyntheticModule(['createServer'], function () {
        this.setExport('createServer', () => { throw Error('Unexpected TLS server in plaintext bind fixture'); });
      }, { context });
      if (name === './systemdSocket.js') return new SyntheticModule(['systemdSocketFd'], function () {
        this.setExport('systemdSocketFd', () => null);
      }, { context });
      if (name === './systemdTls.js') return new SyntheticModule(['systemdTlsOptions'], function () {
        this.setExport('systemdTlsOptions', () => null);
      }, { context });
      if (name === './listeningLog.js') return new SyntheticModule(['logListeningAddress'], function () {
        this.setExport('logListeningAddress', () => {});
      }, { context });
      if (name === './env.js') return new SyntheticModule(['port', 'bindHost'], function () {
        this.setExport('port', 0); this.setExport('bindHost', bindHost);
      }, { context });
      if (name === './http/router.js') return new SyntheticModule(['route'], function () {
        this.setExport('route', (_req, res) => { res.writeHead(200); res.end('fixture'); });
      }, { context });
      throw Error('Unexpected server dependency: ' + name);
    });
    let result;
    try {
      await module.evaluate(); await ready;
      const address = server.address();
      const status = await new Promise((resolve, reject) => {
        const request = get({ hostname: '127.0.0.1', port: address.port, path: '/api/health' }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
        request.setTimeout(1500, () => request.destroy(Error('Loopback fixture timeout')));
      });
      result = { address: address.address, port: address.port, status };
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }
    process.stdout.write(JSON.stringify({ ...result, closed: !server.listening }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', expression], {
    env, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

describe('resolver listener bind host', () => {
  test('binds only to loopback by default when HOST is absent', () => {
    expect(readBindHost()).toBe('127.0.0.1');
  });

  test.each(['', '  '])('blank HOST value %j also uses loopback', host => {
    expect(readBindHost(host)).toBe('127.0.0.1');
  });

  test.each(['0.0.0.0', '::', '::1', '192.168.10.2'])(
    'preserves an explicit HOST=%s for operator-controlled deployment', host => {
      expect(readBindHost(host)).toBe(host);
    }
  );

  test.each([undefined, '', '  '])('real listen(0) binds only to loopback with HOST=%j', host => {
    const result = listenAddress(host);
    expect(result.address).toBe('127.0.0.1');
    expect(result.port).toBeGreaterThan(0);
    expect(result.status).toBe(200);
    expect(result.closed).toBe(true);
  });

  test('real listen(0) preserves the explicit all-interface operator override', () => {
    const result = listenAddress('0.0.0.0');
    expect(result.address).toBe('0.0.0.0');
    expect(result.port).toBeGreaterThan(0);
    expect(result.status).toBe(200);
    expect(result.closed).toBe(true);
  });
});
