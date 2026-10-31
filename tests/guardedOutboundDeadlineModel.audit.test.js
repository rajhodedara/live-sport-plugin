'use strict';

// Controlled-clock models prove deadline accounting and signal wiring only.
// They do not prove physical socket cancellation; the HTTP fixture covers that.
jest.mock('undici', () => ({
  Agent: jest.fn().mockImplementation(() => ({ close: jest.fn().mockResolvedValue(undefined) })),
  Socks5ProxyAgent: class {},
  buildConnector: jest.fn(),
  request: jest.fn()
}));

const dns = require('node:dns');
const { request } = require('undici');
const { guardedFetch, closeGuardedDispatcher } = require('../src/services/GuardedOutbound');
const publicRecords = [{ address: '93.184.216.34', family: 4 }];

function track(pending) {
  const state = { settled: false };
  pending.then(value => {
    state.settled = true;
    state.value = value;
  }, error => {
    state.settled = true;
    state.error = error;
  });
  return state;
}

describe('guarded outbound deadline accounting model', () => {
  let lookup, timeout;

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    request.mockReset();
    lookup = jest.spyOn(dns.promises, 'lookup');
    // Node's intrinsic AbortSignal.timeout does not follow Jest's fake clock.
    timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Model deadline exceeded', 'TimeoutError')), ms);
      return controller.signal;
    });
  });

  afterEach(async () => {
    try {
      await closeGuardedDispatcher();
    } finally {
      jest.restoreAllMocks();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test('DNS, redirect headers, and the final body consume the original 150 ms', async () => {
    lookup.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(publicRecords), 20)));
    const redirectBody = { on: jest.fn(), destroy: jest.fn() };
    const cancelled = jest.fn();
    const requestTimes = [];
    let finalBody;
    request.mockImplementationOnce(() => {
      requestTimes.push(performance.now());
      return new Promise(resolve => setTimeout(() => resolve({
        statusCode: 302, headers: { location: '/body' }, body: redirectBody
      }), 30));
    }).mockImplementationOnce((_url, { signal }) => {
      requestTimes.push(performance.now());
      finalBody = {
        arrayBuffer: jest.fn(() => new Promise((_, reject) => {
          const onAbort = () => {
            cancelled(signal.reason);
            reject(signal.reason);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }))
      };
      return Promise.resolve({ statusCode: 200, headers: {}, body: finalBody });
    });

    const state = track(guardedFetch('http://cdn.example.org/redirect', { timeoutMs: 150 }));
    await jest.advanceTimersByTimeAsync(20);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toMatchObject({ headersTimeout: 130, bodyTimeout: 130 });

    await jest.advanceTimersByTimeAsync(50);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(requestTimes).toEqual([20, 70]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      'http://cdn.example.org/redirect', 'http://cdn.example.org/body'
    ]);
    expect(request.mock.calls[1][1]).toMatchObject({ headersTimeout: 80, bodyTimeout: 80 });
    expect(redirectBody.destroy).toHaveBeenCalledTimes(1);
    expect(finalBody.arrayBuffer).toHaveBeenCalledTimes(1);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(150);
    const signal = timeout.mock.results[0].value;
    expect(request.mock.calls[0][1].signal).toBe(signal);
    expect(request.mock.calls[1][1].signal).toBe(signal);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(79);
    expect(performance.now()).toBe(149);
    expect(state.settled).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(performance.now()).toBe(150);
    expect(state.settled).toBe(true);
    expect(state.error).toMatchObject({ name: 'TimeoutError' });
    expect(state.error).toBe(signal.reason);
    expect(state.value).toBeUndefined();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith(signal.reason);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stalled DNS expires at 150 ms and a late answer cannot start a request', async () => {
    let releaseDns;
    lookup.mockImplementationOnce(() => new Promise(resolve => { releaseDns = resolve; }));
    const state = track(guardedFetch('http://cdn.example.org/dns', { timeoutMs: 150 }));

    await jest.advanceTimersByTimeAsync(149);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(state.settled).toBe(false);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(150);
    const signal = timeout.mock.results[0].value;
    expect(signal.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(performance.now()).toBe(150);
    expect(state.settled).toBe(true);
    expect(state.error).toMatchObject({ name: 'TimeoutError' });
    expect(state.error).toBe(signal.reason);
    expect(request).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(50);
    releaseDns(publicRecords);
    await jest.advanceTimersByTimeAsync(0);
    expect(performance.now()).toBe(200);
    expect(state.error).toBe(signal.reason);
    expect(request).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
