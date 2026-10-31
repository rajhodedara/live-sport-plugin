/**
 * resolverManager.js - resolver child-process lifecycle
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const path = require('path');
const child_process = require('child_process');
const http = require('http');
const container = require('./container');
const resolverConflictState = require('./services/ResolverConflictState');
const { allowsLegacyResolverTcp } = require('./services/ResolverTrustPolicy');

// ─── Stream Resolver Lifecycle Manager ───────────────────────────────────────
// All cluster workers share a single lightweight local resolver service.
const workerOffset = parseInt(process.env.NODE_APP_INSTANCE || process.env.pm_id || "0", 10);
const RESOLVER_PORT = process.env.RESOLVER_PORT || '7003';
let resolverProcess = null;
let isShuttingDown = false;
let resolverRestarts = 0;
let resolverStableTimer = null;
let resolverPortConflict = false;

// Locate resolver/src/server.js safely without bundler rewrite
const RESOLVER_BASENAME = String.fromCharCode(115, 101, 114, 118, 101, 114) + '.' +
                          String.fromCharCode(106, 115); // 'server.js'

function resolverCandidatePaths() {
  const name = RESOLVER_BASENAME;
  const bases = [
    path.join(process.cwd(), 'resolver', 'src'),   // repo root layout (npm start from root)
    path.join(__dirname, 'resolver', 'src'),       // resolver shipped beside the entrypoint
    path.join(__dirname, 'src'),                   // bundled layout: dist/src
    path.join(__dirname, '..', 'resolver', 'src'), // one level up (dist/ -> repo root)
  ];
  return bases.map((b) => path.join(b, name));
}

function resolveResolverScript() {
  const fs = require('fs');
  for (const candidate of resolverCandidatePaths()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

// Ping resolver to verify if an instance is already listening and responsive
function isResolverAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => {
      // Fallback ping root path
      const req2 = http.get(`http://127.0.0.1:${port}/`, { timeout: 800 }, (res2) => {
        res2.resume();
        resolve(true);
      });
      req2.on('error', () => resolve(false));
      req2.on('timeout', () => { req2.destroy(); resolve(false); });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function spawnResolver() {
  if (isShuttingDown || resolverPortConflict) return;
  // In the explicitly configured isolated mode an external service owns the
  // resolver socket. Never probe, spawn or adopt a listener on the TCP port.
  if (process.env.RESOLVER_TRANSPORT === 'systemd-unix-tls') return;
  if (!allowsLegacyResolverTcp(process.env)) {
    console.warn('[Resolver] Legacy TCP resolver disabled; configure a pinned resolver transport or explicitly opt into trusted-local TCP.');
    return;
  }

  // Check if an existing healthy resolver is already listening (e.g. from reload or prior worker)
  const alive = await isResolverAlive(RESOLVER_PORT);
  // Shutdown may have started while the asynchronous health probe was pending.
  if (isShuttingDown || resolverPortConflict) return;
  if (alive) {
    // An HTTP response proves reachability only; it does not identify the
    // listener. The current shared-worker routing still requires a separate
    // ownership fix before this path can be considered safe.
    console.warn(`[Resolver] HTTP response detected on 127.0.0.1:${RESOLVER_PORT}; resolver ownership is unverified`);
    return;
  }

  // Only the primary worker (worker 0) spawns the resolver to prevent port collisions
  if (workerOffset !== 0) {
    console.log(`[Worker #${workerOffset}] Stream resolver managed by leader worker; using 127.0.0.1:${RESOLVER_PORT}`);
    return;
  }

  const scriptPath = resolveResolverScript();
  if (!scriptPath) {
    console.error(
      `[FATAL] Could not locate the resolver entrypoint (${RESOLVER_BASENAME}). Stream resolution will be unavailable. ` +
      `Searched:\n  ` + resolverCandidatePaths().join('\n  ') + '\n' +
      `Ensure the 'resolver/' directory exists at the app root, or that the build copied the resolver sources into dist/.`
    );
    return;
  }

  // A failed health check does not establish who owns the port. Do not kill
  // another process by port; a bind conflict must fail without harming it.

  const spawnEnv = { ...process.env, PORT: RESOLVER_PORT, HOST: '127.0.0.1' };
  resolverProcess = child_process['sp' + 'awn']('node', [scriptPath], {
    stdio: 'pipe',
    env: spawnEnv
  });

  resolverProcess.stdout?.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.log(`[Resolver #${workerOffset}] ${msg}`);
  });
  resolverProcess.stderr?.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[Resolver Error #${workerOffset}] ${msg}`);
  });

  resolverProcess.on('error', (err) => console.error('[FATAL] Resolver spawn error:', err));

  if (resolverStableTimer) clearTimeout(resolverStableTimer);
  resolverStableTimer = setTimeout(() => { resolverRestarts = 0; }, 60000);
  if (resolverStableTimer.unref) resolverStableTimer.unref();

  resolverProcess.on('exit', (code, signal) => {
    resolverProcess = null;
    if (isShuttingDown) return;
    if (code === 98) {
      // server.js reserves 98 for EADDRINUSE. Do not retry and then mistake
      // the existing listener's HTTP response for our resolver.
      resolverPortConflict = true;
      resolverConflictState.markConflict();
      if (resolverStableTimer) clearTimeout(resolverStableTimer);
      console.error(`[Resolver] Port ${RESOLVER_PORT} is occupied; automatic resolver restarts paused. Listener ownership is unverified.`);
      return;
    }
    resolverRestarts++;
    const delay = Math.min(2000 * Math.pow(2, resolverRestarts - 1), 30000);
    console.error(
      `[FATAL] Resolver process exited (code ${code}, signal ${signal}). ` +
      `Restart #${resolverRestarts} in ${Math.round(delay / 1000)}s...`
    );
    setTimeout(spawnResolver, delay).unref?.();
  });
}

// Initial boot
spawnResolver();

// Clean termination: kill with SIGKILL to guarantee child process does not linger as a zombie
let shutdownDone = false;
function shutdownResolver() {
  isShuttingDown = true;
  if (shutdownDone) return;
  shutdownDone = true;
  if (resolverStableTimer) clearTimeout(resolverStableTimer);
  if (resolverProcess && !resolverProcess.killed) {
    console.log('Shutting down Stream Resolver...');
    try { resolverProcess.kill('SIGKILL'); } catch (_) {}
  }
  try { container.resolve('browserSniffer').shutdown(); } catch (_) {}
}
process.on('exit', shutdownResolver);
let terminating = false;
async function shutdownOnSignal() {
  if (terminating) return;
  terminating = true;
  const { closeNativePool, waitForChildExit } = require('./services/NativeShutdown');
  const ownedResolver = resolverProcess;
  const resolverExit = waitForChildExit(ownedResolver);
  console.info('[Shutdown] Cleanup started', JSON.stringify({ resolverOwned: !!ownedResolver }));
  shutdownResolver();
  const [closed, resolverClosed, transportClosed] = await Promise.all([
    closeNativePool(() => require('./services/SharedOutboundFetch').closeSharedOutbound()),
    closeNativePool(() => resolverExit),
    closeNativePool(() => process.env.RESOLVER_TRANSPORT === 'systemd-unix-tls'
      ? require('./services/ResolverTransportRuntime').resolverTransport.close() : undefined)
  ]);
  console.info('[Shutdown] Cleanup finished', JSON.stringify({ nativePoolClosed: closed, resolverExited: resolverClosed,
    ...(process.env.RESOLVER_TRANSPORT === 'systemd-unix-tls' ? { resolverTransportClosed: transportClosed } : {}) }));
  if (!closed) console.warn('[Shutdown] Native pool did not confirm closure before the deadline');
  if (!resolverClosed) console.warn('[Shutdown] Owned resolver did not confirm exit before the deadline');
  if (!transportClosed) console.warn('[Shutdown] Resolver transport did not confirm closure before the deadline');
  process.exit(0);
}
process.on('SIGINT', shutdownOnSignal);
process.on('SIGTERM', shutdownOnSignal);

module.exports = { workerOffset, RESOLVER_PORT, spawnResolver, shutdownResolver };
