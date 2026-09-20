'use strict';

const {
  withRetry,
  isTransientError,
  isTransientStatus,
  backoffDelay,
} = require('../src/services/retry');

// Keep the suite fast: the policy is about *which* failures are retried and
// when it must stop, not about real wall-clock backoff.
const FAST = { baseDelayMs: 1, maxDelayMs: 2 };

describe('transient classification', () => {
  it('treats connection-level failures as transient', () => {
    expect(isTransientError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('boom'), { code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('impit timeout 5000ms'))).toBe(true);
  });

  it('treats a nested undici cause as transient', () => {
    const err = new Error('fetch failed');
    err.cause = Object.assign(new Error('inner'), { code: 'ECONNREFUSED' });
    expect(isTransientError(err)).toBe(true);
  });

  it('does not retry our own bugs', () => {
    expect(isTransientError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientError(new Error('Invalid URL'))).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it('does not retry a deliberate abort', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isTransientError(err)).toBe(false);
  });

  it('retries overload statuses but believes refusals', () => {
    expect(isTransientStatus(503)).toBe(true);
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(408)).toBe(true);
    // A 403/404 is a working server giving a real answer.
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(404)).toBe(false);
    expect(isTransientStatus(200)).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, FAST)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('recovers when a transient failure is followed by success', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('recovered');
    await expect(withRetry(fn, { ...FAST, attempts: 3 })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt budget and rethrows the real error', async () => {
    const err = Object.assign(new Error('still down'), { code: 'ECONNRESET' });
    const fn = jest.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { ...FAST, attempts: 3 })).rejects.toThrow('still down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('fails fast on a non-transient error', async () => {
    const fn = jest.fn().mockRejectedValue(new TypeError('bug'));
    await expect(withRetry(fn, { ...FAST, attempts: 5 })).rejects.toThrow('bug');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient *result* and returns the last one when attempts run out', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 503 });
    const out = await withRetry(fn, {
      ...FAST,
      attempts: 3,
      shouldRetryResult: (r) => isTransientStatus(r.status),
    });
    // The caller still gets the real status to act on, not an exception.
    expect(out).toEqual({ status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once the deadline leaves no room', async () => {
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }));
    await expect(withRetry(fn, {
      attempts: 5,
      baseDelayMs: 50,
      maxDelayMs: 50,
      deadlineAt: Date.now() + 10, // already effectively expired
    })).rejects.toThrow('slow');
    // No budget for a second attempt, so exactly one call was made.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honours the deadline for retryable results too', async () => {
    const fn = jest.fn().mockResolvedValue({ status: 500 });
    const out = await withRetry(fn, {
      attempts: 5,
      baseDelayMs: 50,
      maxDelayMs: 50,
      deadlineAt: Date.now() + 10,
      shouldRetryResult: () => true,
    });
    expect(out).toEqual({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry so failures are visible in the logs', async () => {
    const onRetry = jest.fn();
    const fn = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('blip'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok');
    await withRetry(fn, { ...FAST, attempts: 2, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1 });
  });
});

describe('backoffDelay', () => {
  it('grows with the attempt number and never exceeds the cap', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const d = backoffDelay(attempt, 100, 1000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });

  it('uses full jitter, so a batch of callers does not re-collide', () => {
    const delays = new Set(Array.from({ length: 50 }, () => backoffDelay(4, 100, 1000)));
    expect(delays.size).toBeGreaterThan(1);
  });
});
