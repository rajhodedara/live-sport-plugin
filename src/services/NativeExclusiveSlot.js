'use strict';

// Local integration candidate: one existing native client, at most one unsettled operation.
// An operation must await its entire body and MUST NOT pass the caller signal
// to Impit's JS wrapper: its early Promise.race would hide native completion.
function createNativeExclusiveSlot(client, closeConnections, { staleWarningMs = 5000, warn = console.warn } = {}) {
  let active = null, disposed = false;
  return {
    get busy() { return active !== null; },
    whenIdle() { return active?.settled || Promise.resolve(); },
    dispose() {
      if (active) throw Object.assign(new Error('Native slot is occupied'), { code: 'ERR_NATIVE_SLOT_BUSY' });
      disposed = true;
      // Drop the JS strong reference; this does not force native reclamation.
      client = null;
    },
    run(operation, { signal: callerSignal, timeoutMs = 15000 } = {}) {
      if (disposed) return Promise.reject(Object.assign(new Error('Native slot disposed'), { code: 'ERR_NATIVE_SLOT_CLOSED' }));
      if (active) return Promise.reject(Object.assign(new Error('Native slot is occupied'), { code: 'ERR_NATIVE_SLOT_BUSY' }));
      if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000) {
        return Promise.reject(new RangeError('Invalid laboratory operation deadline'));
      }
      let rejectCaller;
      const canceled = new Promise((_, reject) => { rejectCaller = reject; });
      const lease = { canceled: false, controller: new AbortController(), startedAt: performance.now() };
      active = lease;
      const cancel = reason => {
        if (active !== lease || lease.canceled) return;
        lease.canceled = true;
        lease.reason = reason;
        lease.controller.abort(reason);
        // Resolve the caller independently of native settlement. The lease is
        // deliberately retained until operation AND body actually settle.
        lease.warningTimer = setTimeout(() => {
          if (active === lease) warn('[GuardedOutbound] Native operation remains active after cancellation',
            JSON.stringify({ ageMs: Math.max(0, Math.round(performance.now() - lease.startedAt)) }));
        }, staleWarningMs);
        lease.warningTimer.unref?.();
        try { closeConnections(reason); }
        catch (cleanupError) {
          rejectCaller(new AggregateError([reason, cleanupError], 'Native slot cancellation cleanup failed'));
          return;
        }
        rejectCaller(reason);
      };
      const callerAbort = () => cancel(callerSignal.reason);
      callerSignal?.addEventListener('abort', callerAbort, { once: true });
      const timer = setTimeout(() => cancel(new DOMException('Native slot deadline', 'TimeoutError')), timeoutMs);
      const pending = Promise.resolve().then(() => {
        if (lease.canceled) throw lease.reason;
        return operation(client, lease.controller.signal);
      }).finally(() => {
        clearTimeout(timer);
        clearTimeout(lease.warningTimer);
        callerSignal?.removeEventListener('abort', callerAbort);
        try { closeConnections(); } finally { if (active === lease) active = null; }
      });
      lease.settled = pending.then(() => {}, () => {});
      return Promise.race([pending, canceled]);
    }
  };
}

module.exports = { createNativeExclusiveSlot };
