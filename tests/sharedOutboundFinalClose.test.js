'use strict';

// A FINAL close (process shutdown) must not be undone by an in-flight retry or by a
// request that arrives while the process winds down. A plain close keeps its old
// meaning. The tests share module state and are order-dependent on purpose.
process.env.GUARDED_NATIVE_ISOLATION = 'true';

let mockCreated = 0;
jest.mock('../src/services/IsolatedNativePoolCandidate', () => ({
  createIsolatedNativePoolCandidate: () => {
    mockCreated++;
    return {
      fetch: async () => ({ ok: true, status: 200, headers: new Headers(), bodyTruncated: false, text: async () => 'native' }),
      close: async () => {},
    };
  },
}));
jest.mock('../src/services/GuardedOutbound', () => ({
  guardedFetch: async () => ({ ok: true, status: 200, headers: new Headers(), bodyTruncated: false, text: async () => 'fallback' }),
}));

const shared = require('../src/services/SharedOutboundFetch');

test('a plain close still lets a later request build a fresh pool', async () => {
  await shared.fetchSharedOutbound('https://example.org/a', { attempts: 1 });
  expect(mockCreated).toBe(1);
  await shared.closeSharedOutbound();
  await shared.fetchSharedOutbound('https://example.org/b', { attempts: 1 });
  expect(mockCreated).toBe(2);
});

test('after a final close no pool is created and the request completes through the guarded fallback', async () => {
  await shared.closeSharedOutbound({ final: true });
  const before = mockCreated;
  const response = await shared.fetchSharedOutbound('https://example.org/c', { attempts: 1 });
  expect(mockCreated).toBe(before);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('fallback');
});
