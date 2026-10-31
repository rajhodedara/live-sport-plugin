const { spawn: spawnChild } = require('child_process');

const CLIENT_ENV = {
  RESOLVER_TRUST_LEGACY_TCP: 'true',
  RESOLVER_PORT: undefined,
  RESOLVE_CACHE_SHARED: undefined,
  RESOLVER_TRANSPORT: undefined,
};
const CHILD_ONLY_ENV = [
  'BASE_URL', 'RESOLVER_SYSTEMD_SOCKET', 'RESOLVER_SYSTEMD_TLS',
  'LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES', 'CREDENTIALS_DIRECTORY',
  'RESOLVER_CERT_DIR', 'RESOLVER_TLS_SERVERNAME', 'RESOLVER_SOCKET_PATH',
];

// Keep the real server entrypoint and fixed port: PORT=0 currently selects 3000.
// A listening line from our child is required before making any HTTP request,
// so a foreign healthy listener cannot hide this child's EADDRINUSE failure.
function createOwnedResolverFixture({
  port,
  serverPath,
  spawn = spawnChild,
  fetch: request = (...args) => global.fetch(...args),
  env = process.env,
  startupTimeoutMs = 10000,
  requestTimeoutMs = 1000,
  cleanupTimeoutMs = 1000,
  outputLimit = 8192,
}) {
  const base = `http://127.0.0.1:${port}`;
  let child;
  let savedEnv;
  let started = false;
  let exited = false;
  let closed = false;
  let processError;
  let exitDescription = 'not exited';
  let stdout = '';
  let stderr = '';
  let pendingLine = '';
  let lineTooLong = false;
  let stopPromise;
  let resolveListening;
  let rejectDeath;
  let resolveClose;
  const listening = new Promise(resolve => { resolveListening = resolve; });
  const death = new Promise((_, reject) => { rejectDeath = reject; });
  // Exit may occur after successful startup, when nobody is racing this promise.
  death.catch(() => {});
  const close = new Promise(resolve => { resolveClose = resolve; });
  const tail = (previous, chunk) => (previous + String(chunk)).slice(-outputLimit);

  function diagnostics() {
    return [
      `Owned resolver at ${base}, child pid=${child?.pid ?? 'not spawned'}: ${exitDescription}`,
      processError ? `child error: ${processError.message}` : '',
      `stdout (last ${outputLimit} chars):\n${stdout || '<empty>'}`,
      `stderr (last ${outputLimit} chars):\n${stderr || '<empty>'}`,
    ].filter(Boolean).join('\n');
  }

  function restoreEnvironment() {
    if (!savedEnv) return;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    savedEnv = null;
  }

  function assertAlive() {
    if (processError) throw new Error(`child error: ${processError.message}`);
    if (exited || child.exitCode != null || child.signalCode != null) {
      throw new Error(`child ${exitDescription}`);
    }
  }

  function assertRunning() {
    try {
      if (!child) throw new Error('owned resolver has not started');
      assertAlive();
    } catch (error) {
      throw new Error(`${error.message}\n${diagnostics()}`);
    }
  }

  async function bounded(operation, timeoutMs, message, onTimeout = () => {}) {
    let timer;
    try {
      return await Promise.race([
        operation,
        death,
        new Promise((_, reject) => {
          timer = setTimeout(() => { onTimeout(); reject(new Error(message)); }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe(pathname, valid) {
    assertAlive();
    const controller = new AbortController();
    try {
      await bounded((async () => {
        const response = await request(base + pathname, { signal: controller.signal });
        assertAlive();
        if (response.status !== 200) throw new Error(`${pathname}: HTTP ${response.status}`);
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
          throw new Error(`${pathname}: expected application/json Content-Type`);
        }
        let body;
        try { body = await response.json(); }
        catch (error) { throw new Error(`${pathname}: invalid JSON (${error.message})`); }
        if (!valid(body)) {
          throw new Error(`${pathname}: unexpected JSON ${String(JSON.stringify(body)).slice(0, 512)}`);
        }
      })(), requestTimeoutMs, `${pathname}: request timed out`, () => controller.abort());
      assertAlive();
    } finally {
      controller.abort();
    }
  }

  async function waitForClose() {
    if (closed) return true;
    let timer;
    try {
      return await Promise.race([
        close.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), cleanupTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function stop() {
    if (!stopPromise) stopPromise = (async () => {
      if (!child || closed) return;
      if (!exited) child.kill('SIGTERM');
      if (await waitForClose()) return;
      if (!exited) child.kill('SIGKILL');
      if (!await waitForClose()) {
        throw new Error(`owned child did not close after bounded cleanup\n${diagnostics()}`);
      }
    })();
    return stopPromise;
  }

  async function start() {
    if (started) throw new Error('owned resolver fixture already started');
    started = true;
    savedEnv = Object.fromEntries(Object.keys(CLIENT_ENV).map(name => [name, env[name]]));
    for (const [name, value] of Object.entries({ ...CLIENT_ENV, RESOLVER_PORT: String(port) })) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const childEnv = { ...env, PORT: String(port), HOST: '127.0.0.1' };
    for (const name of CHILD_ONLY_ENV) delete childEnv[name];
    try {
      child = spawn(process.execPath, [serverPath], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => {
        stdout = tail(stdout, chunk);
        // Check complete lines across chunks while keeping incomplete output bounded.
        const parts = String(chunk).split('\n');
        for (let index = 0; index < parts.length; index++) {
          if (!lineTooLong) {
            pendingLine += parts[index];
            if (pendingLine.length > base.length + 2) {
              pendingLine = '';
              lineTooLong = true;
            }
          }
          if (index < parts.length - 1) {
            if (!lineTooLong && pendingLine.replace(/\r$/, '') === `${base}/`) resolveListening();
            pendingLine = '';
            lineTooLong = false;
          }
        }
      });
      child.stderr.on('data', chunk => { stderr = tail(stderr, chunk); });
      child.on('error', error => {
        processError = error;
        rejectDeath(new Error(`child error: ${error.message}`));
      });
      child.on('exit', (code, signal) => {
        exited = true;
        exitDescription = `exit code=${code} signal=${signal}`;
        rejectDeath(new Error(`child ${exitDescription}`));
      });
      child.on('close', (code, signal) => {
        closed = true;
        exited = true;
        exitDescription = `exit code=${code} signal=${signal} (closed)`;
        resolveClose();
        rejectDeath(new Error(`child ${exitDescription}`));
      });
      await bounded(listening, startupTimeoutMs, `child never reported listening at ${base}/`);
      await probe('/api/health', body => body?.ok === true &&
        typeof body.uptime === 'number' && Number.isFinite(body.uptime) && body.uptime >= 0);
      await probe('/api/cache-stats', body => body !== null && typeof body === 'object' &&
        ['entries', 'ok', 'failed', 'claims'].every(name => Number.isSafeInteger(body[name]) && body[name] === 0));
      return fixture;
    } catch (error) {
      let cleanupError;
      try { await stop(); } catch (failure) { cleanupError = failure.message; }
      restoreEnvironment();
      throw new Error(`${error.message}\n${diagnostics()}${cleanupError ? `\nCleanup: ${cleanupError}` : ''}`);
    }
  }

  async function dispose() {
    try { await stop(); } finally { restoreEnvironment(); }
  }

  const fixture = { start, stop, dispose, diagnostics, assertRunning };
  return fixture;
}

module.exports = { createOwnedResolverFixture };
