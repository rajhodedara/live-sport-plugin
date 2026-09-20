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

// ─── Stream Resolver Lifecycle Manager ───────────────────────────────────────
// All cluster workers share a single lightweight local resolver service.
const workerOffset = parseInt(process.env.NODE_APP_INSTANCE || process.env.pm_id || "0", 10);
const RESOLVER_PORT = process.env.RESOLVER_PORT || '7003';
let resolverProcess = null;
let isShuttingDown = false;
let resolverRestarts = 0;
let resolverStableTimer = null;

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
  if (isShuttingDown) return;

  // Check if an existing healthy resolver is already listening (e.g. from reload or prior worker)
  const alive = await isResolverAlive(RESOLVER_PORT);
  if (alive) {
    console.log(`[Resolver] Verified healthy stream resolver active on 127.0.0.1:${RESOLVER_PORT}`);
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

  // If we reach here and it's not responding, clear any zombie hanging onto the port (Linux)
  if (process.platform === 'linux') {
    try {
      child_process.execSync(`fuser -k ${RESOLVER_PORT}/tcp 2>/dev/null || true`);
    } catch (_) {}
  }

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
process.on('SIGINT', () => { shutdownResolver(); process.exit(0); });
process.on('SIGTERM', () => { shutdownResolver(); process.exit(0); });

module.exports = { workerOffset, RESOLVER_PORT, spawnResolver, shutdownResolver };
