/**
 * resolverManager.js - resolver child-process lifecycle
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const path = require('path');
const child_process = require('child_process');
const container = require('./container');

// ─── Spawn the Streamed.pk Resolver ───────────────────────────────────────────

// In PM2 cluster mode, each worker gets its own isolated resolver port (7003, 7004, 7005, 7006...)
const workerOffset = parseInt(process.env.NODE_APP_INSTANCE || process.env.pm_id || "0", 10);
const RESOLVER_PORT = process.env.RESOLVER_PORT || String(7003 + workerOffset);
let resolverProcess = null;
let isShuttingDown = false;
let resolverRestarts = 0;
let resolverStableTimer = null;

// Locate resolver/src/server.js.
//
// The script NAME is kept as separate character codes concatenated at runtime
// (never a literal "server.js") because the bundler's asset relocator rewrites
// path-like string literals. A plain literal caused it to point at `dist/src` —
// a DIRECTORY that exists, so the existence check passed and the child was
// spawned against a folder, failing with "Cannot find module ...\dist\src".
//
// Candidate NAMES (not absolute paths) are resolved against each base directory
// at runtime, so there is nothing for the bundler to rewrite. In a bundle the
// resolver sources are emitted next to the bundle itself (see the build script),
// which is why __dirname is a first-class candidate.
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
      // Must be a FILE — a directory of the same name must never match.
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

function spawnResolver() {
  if (isShuttingDown) return;
  const spawnEnv = { ...process.env, PORT: RESOLVER_PORT, HOST: '127.0.0.1' };

  const scriptPath = resolveResolverScript();

  if (!scriptPath) {
    console.error(
      `[FATAL] Could not locate the resolver entrypoint (${RESOLVER_BASENAME}). Stream resolution will be unavailable. ` +
      `Searched:\n  ` + resolverCandidatePaths().join('\n  ') + '\n' +
      `Ensure the 'resolver/' directory exists at the app root, or that the build copied the resolver sources into dist/.`
    );
    return; // Do NOT respawn: a missing script can never fix itself, and a tight loop only hides the cause.
  }

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

  // Treat a run that survives this long as healthy and reset the backoff, so a
  // single crash-loop cannot permanently degrade the restart delay.
  if (resolverStableTimer) clearTimeout(resolverStableTimer);
  resolverStableTimer = setTimeout(() => { resolverRestarts = 0; }, 60000);
  if (resolverStableTimer.unref) resolverStableTimer.unref();

  resolverProcess.on('exit', (code, signal) => {
    if (isShuttingDown) return;
    resolverRestarts++;
    // Exponential backoff, capped: 2s, 4s, 8s, 16s, 30s, 30s...
    const delay = Math.min(2000 * Math.pow(2, resolverRestarts - 1), 30000);
    console.error(
      `[FATAL] Resolver process exited (code ${code}, signal ${signal}). ` +
      `Restart #${resolverRestarts} in ${Math.round(delay / 1000)}s...`
    );
    setTimeout(spawnResolver, delay).unref?.();
  });
}

spawnResolver();

// Idempotent: 'exit', SIGINT and SIGTERM can all fire; the resolver must be
// killed exactly once and the flag must not be reset mid-shutdown.
let shutdownDone = false;
function shutdownResolver() {
  isShuttingDown = true;
  if (shutdownDone) return;
  shutdownDone = true;
  if (resolverStableTimer) clearTimeout(resolverStableTimer);
  if (resolverProcess && !resolverProcess.killed) {
    console.log('Shutting down Stream Resolver...');
    try { resolverProcess.kill(); } catch (_) {}
  }
  // Shut down the headless browser sniffer if it was ever launched
  try { container.resolve('browserSniffer').shutdown(); } catch (_) {}
}
process.on('exit', shutdownResolver);
process.on('SIGINT', () => { shutdownResolver(); process.exit(0); });
process.on('SIGTERM', () => { shutdownResolver(); process.exit(0); });

// A single unhandled error must not take down a long-running stream server.
// Log loudly and keep serving; fatal state is handled by the supervisor.

module.exports = { workerOffset, RESOLVER_PORT, spawnResolver, shutdownResolver };
