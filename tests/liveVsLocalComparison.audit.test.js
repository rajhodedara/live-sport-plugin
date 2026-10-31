'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, 'liveVsLocalComparison.test.js');
const source = fs.readFileSync(filename, 'utf8');
const hostedChecks = [
  {
    title: 'live hosted manifest is accessible and valid semver',
    url: 'https://nuviosports.xyz/manifest.json',
    requestMs: 5000,
    payload: { id: 'community.nuvio.live-sports', version: '3.1.3' },
    assertions: 4
  },
  {
    title: 'live hosted catalogs respond with valid metas array',
    url: 'https://nuviosports.xyz/catalog/tv/nuvio_sports.json',
    requestMs: 6000,
    payload: { metas: [] },
    assertions: 2
  }
];

// Execute the real test callbacks, with no native fetch or require in the VM.
// This models deadline wiring and visible failures, not hosted availability or
// physical network cancellation.
function loadHostedChecks(fetch) {
  const registered = new Map();
  const assertions = jest.fn(value => expect(value));
  const timeout = jest.fn(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Hosted request deadline', 'TimeoutError')), ms);
    return controller.signal;
  });

  vm.runInNewContext(source, {
    describe: (_title, register) => register(),
    test: (title, run, timeoutMs) => registered.set(title, { run, timeoutMs }),
    expect: assertions,
    fetch,
    AbortSignal: { timeout }
  }, { filename });

  return { registered, assertions, timeout };
}

function pendingUntilAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

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

beforeEach(() => jest.useFakeTimers({ now: 0 }));
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('both hosted checks expose fetch and JSON errors instead of passing silently', async () => {
  for (const spec of hostedChecks) {
    for (const stage of ['fetch', 'json']) {
      const failure = new Error(`Injected ${stage} failure`);
      const fetch = jest.fn();
      if (stage === 'fetch') fetch.mockRejectedValue(failure);
      else fetch.mockResolvedValue({ status: 200, json: jest.fn().mockRejectedValue(failure) });
      const { registered, assertions } = loadHostedChecks(fetch);

      await expect(registered.get(spec.title).run()).rejects.toBe(failure);
      expect(assertions).toHaveBeenCalledTimes(stage === 'fetch' ? 0 : 1);
    }
  }
});

test.each(['headers', 'body'])('the catalog %s wait rejects at its request deadline before the Jest limit', async phase => {
  const json = jest.fn();
  const fetch = jest.fn((_url, { signal }) => {
    if (phase === 'headers') return pendingUntilAbort(signal);
    return new Promise(resolve => setTimeout(() => {
      json.mockImplementation(() => pendingUntilAbort(signal));
      resolve({ status: 200, json });
    }, 1000));
  });
  const { registered, assertions, timeout } = loadHostedChecks(fetch);
  const catalog = registered.get(hostedChecks[1].title);
  const state = track(catalog.run());
  const signal = fetch.mock.calls[0][1].signal;

  expect(timeout).toHaveBeenCalledTimes(1);
  expect(timeout).toHaveBeenCalledWith(6000);
  expect(catalog.timeoutMs).toBeGreaterThan(6000);

  await jest.advanceTimersByTimeAsync(5999);
  expect(state.settled).toBe(false);
  expect(signal.aborted).toBe(false);
  expect(assertions).toHaveBeenCalledTimes(phase === 'headers' ? 0 : 1);
  expect(json).toHaveBeenCalledTimes(phase === 'headers' ? 0 : 1);

  await jest.advanceTimersByTimeAsync(1);
  expect(Date.now()).toBe(6000);
  expect(Date.now()).toBeLessThan(catalog.timeoutMs);
  expect(state.settled).toBe(true);
  expect(state.error).toBe(signal.reason);
  expect(state.error).toMatchObject({ name: 'TimeoutError' });
  expect(state.value).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});

test('valid hosted payloads reach every retained assertion using the fixed URLs and request budgets', async () => {
  for (const spec of hostedChecks) {
    const json = jest.fn().mockResolvedValue(spec.payload);
    const fetch = jest.fn().mockResolvedValue({ status: 200, json });
    const { registered, assertions, timeout } = loadHostedChecks(fetch);
    expect(registered.size).toBe(2);
    const check = registered.get(spec.title);

    await check.run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(spec.url, { signal: timeout.mock.results[0].value });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(spec.requestMs);
    expect(check.timeoutMs).toBeGreaterThan(spec.requestMs);
    expect(json).toHaveBeenCalledTimes(1);
    expect(assertions).toHaveBeenCalledTimes(spec.assertions);
  }
});

test('invalid statuses and non-array catalog metas remain assertion failures', async () => {
  const invalidResponses = [
    ...hostedChecks.map(spec => ({ spec, status: 503, payload: spec.payload })),
    { spec: hostedChecks[1], status: 200, payload: { metas: {} } }
  ];
  for (const { spec, status, payload } of invalidResponses) {
    const fetch = jest.fn().mockResolvedValue({ status, json: jest.fn().mockResolvedValue(payload) });
    const { registered } = loadHostedChecks(fetch);
    await expect(registered.get(spec.title).run()).rejects.toThrow();
  }
});
