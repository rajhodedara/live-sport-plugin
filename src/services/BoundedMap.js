'use strict';

/**
 * Map `items` through an async `worker` with at most `limit` calls in flight.
 * Results keep the input order. A rejection from any worker rejects the whole
 * call, like Promise.all, but lanes already running are not interrupted.
 */
async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const width = Math.min(Math.max(1, Math.floor(Number(limit)) || 1), list.length);
  let next = 0;

  async function lane() {
    while (next < list.length) {
      const index = next++;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, lane));
  return results;
}

module.exports = { mapWithConcurrency };
