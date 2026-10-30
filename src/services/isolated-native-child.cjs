'use strict';

// Experimental opt-in child entry point.
const { createNativeGuardedFetch } = require('./NativeGuardedFetch');
let started = false;
// If the supervisor dies, do not leave a native request orphaned.
process.once('disconnect', () => process.exit(1));
// Best effort only: these timers require the child's event loop to run.
if (typeof setInterval === 'function' && typeof setTimeout === 'function') {
  const parent = process.ppid;
  const stop = () => { try { process.kill(process.pid, 'SIGKILL'); } catch (_) { process.exit(1); } };
  setInterval(() => {
    if (process.ppid !== parent) return stop();
    try { process.kill(parent, 0); } catch (failure) { if (failure?.code !== 'EPERM') stop(); }
  }, 2000).unref();
  setTimeout(stop, 40000).unref();
}
process.once('message', async message => {
  if (started) return;
  started = true;
  const diagStart = message?.diagnostic === true ? performance.now() : null;
  const diag = { attempted: 0, pending: 0, failed: 0, backpressure: 0 };
  const sendDiagnostic = payload => {
    if (diagStart === null) return;
    diag.attempted++;
    if (!process.connected || typeof process.send !== 'function') { diag.failed++; return; }
    diag.pending++;
    let settled = false;
    const settle = error => {
      if (settled) return;
      settled = true; diag.pending--;
      if (error) diag.failed++;
    };
    try { if (process.send(payload, settle) === false) diag.backpressure++; }
    catch (_) { settle(true); }
  };
  const sendPhase = (phase, hop) => {
    if (diagStart === null) return;
    sendDiagnostic({ type: 'diagnostic', phase, hop, childElapsedMs: Math.max(0, Math.round(performance.now() - diagStart)) });
  };
  if (diagStart !== null) {
    // One bounded best-effort event. This confirms receipt, not native readiness.
    sendDiagnostic({ type: 'diagnostic', phase: 'request_received' });
  }
  const pool = createNativeGuardedFetch({ maxSlots: 1, ...(diagStart === null ? {} : { onPhase: sendPhase }) });
  try {
    const response = await pool.fetch(message.url, message.options);
    const bytes = Buffer.from(await response.arrayBuffer());
    process.send?.({ type: 'result', status: response.status, url: response.url,
      headers: [...response.headers], bytes, bodyTruncated: response.bodyTruncated,
      ...(diagStart === null ? {} : { diagnosticSnapshot: { ...diag } }) });
  } catch (failure) {
    // Never send upstream URLs, credentials or native exception messages.
    const code = typeof failure.code === 'string' && /^ERR_[A-Z0-9_]{1,80}$/.test(failure.code) ? failure.code : 'ERR_NATIVE_CHILD';
    const kind = failure instanceof TypeError ? 'TypeError' : failure instanceof RangeError ? 'RangeError' : 'Error';
    process.send?.({ type: 'result', error: { code, kind, isFatal: failure.isFatal === true },
      ...(diagStart === null ? {} : { diagnosticSnapshot: { ...diag } }) });
  }
});
