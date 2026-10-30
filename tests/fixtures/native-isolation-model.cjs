'use strict';

// Test-only model of process isolation. `launch` is an injected fake; it must
// return an operation and an exit-confirmed termination promise. It does not
// spawn processes or implement a production transport.
function createIsolationModel(launch, maxSlots = 4) {
  let occupied = 0;
  return {
    get occupied() { return occupied; },
    async run(request, { signal }) {
      signal.throwIfAborted();
      if (occupied >= maxSlots) throw Object.assign(new Error('capacity'), { code: 'ERR_NATIVE_POOL_BUSY' });
      occupied++;
      let worker;
      try { worker = launch(request); }
      catch (error) { occupied--; throw error; }
      let abort;
      const canceled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      const result = Promise.resolve().then(() => worker.result);
      try { return await Promise.race([result, canceled]); }
      finally {
        signal.removeEventListener('abort', abort);
        // Do not free capacity until termination has actually been confirmed.
        Promise.resolve().then(() => worker.terminate()).then(() => { occupied--; }, () => {});
      }
    }
  };
}

module.exports = { createIsolationModel };
