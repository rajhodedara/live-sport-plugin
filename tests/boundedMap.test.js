'use strict';

const { mapWithConcurrency } = require('../src/services/BoundedMap');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  test('never runs more than `limit` workers at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
    });
    expect(peak).toBe(3);
  });

  test('keeps the input order even when workers finish out of order', async () => {
    const out = await mapWithConcurrency([30, 5, 15, 1], 2, async (ms) => { await sleep(ms); return ms; });
    expect(JSON.stringify(out)).toBe('[30,5,15,1]');
  });

  test('handles empty input and a limit larger than the list', async () => {
    expect(JSON.stringify(await mapWithConcurrency([], 4, async (x) => x))).toBe('[]');
    expect(JSON.stringify(await mapWithConcurrency([1, 2], 99, async (x) => x * 2))).toBe('[2,4]');
  });

  test('an invalid limit falls back to one worker at a time', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 'abc', async () => { active++; peak = Math.max(peak, active); await sleep(2); active--; });
    expect(peak).toBe(1);
  });

  test('a worker rejection rejects the call', async () => {
    let message = '';
    try {
      await mapWithConcurrency([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x; });
    } catch (e) { message = e.message; }
    expect(message).toBe('boom');
  });
});
