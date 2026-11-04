'use strict';
const { request } = require('undici');
const { assertOutboundUrl, createGuardedLookup, createGuardedDispatcher } = require('../src/services/GuardedOutbound');
const publicAddress = '93.184.216.34';

const lookup = (fn, host, options = { all: true }) => new Promise((resolve, reject) => fn(host, options, (error, ...result) => error ? reject(error) : resolve(result)));

describe('guarded outbound connection foundation', () => {
  test.each(['http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'http://localhost./'])('rejects %s', async url => {
    await expect(assertOutboundUrl(url)).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
  });

  test('does not pass URL credentials into a transport', async () => {
    await expect(assertOutboundUrl('https://user:password@cdn.example.org/')).rejects.toMatchObject({ reason: 'url_credentials' });
  });

  test('malformed input produces the same explicit blocked error', async () => {
    await expect(assertOutboundUrl('not a URL')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED', reason: 'invalid_url' });
  });

  test.each([['127.0.0.1'], ['10.0.0.1'], [publicAddress, '192.168.1.1'], ['::ffff:127.0.0.1'], ['not-an-address']])('rejects unsafe DNS records %j at connect time', async (...records) => {
    const fn = createGuardedLookup({ resolve: async () => records });
    await expect(lookup(fn, 'cdn.example.org')).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
  });

  test('passes exactly the validated public answers to the socket connector', async () => {
    const fn = createGuardedLookup({ resolve: async () => [publicAddress, '2606:4700:4700::1111'] });
    await expect(lookup(fn, 'cdn.example.org')).resolves.toEqual([[
      { address: publicAddress, family: 4 }, { address: '2606:4700:4700::1111', family: 6 }
    ]]);
    await expect(lookup(fn, 'cdn.example.org', { family: 6 })).resolves.toEqual(['2606:4700:4700::1111', 6]);
  });

  test('the allowlist remains an additional restriction, including at socket lookup', async () => {
    const resolve = jest.fn(async () => [publicAddress]);
    await expect(lookup(createGuardedLookup({ resolve, allowedHosts: ['allowed.example.org'] }), 'other.example.org')).rejects.toMatchObject({ reason: 'host_not_allowlisted' });
    expect(resolve).not.toHaveBeenCalled();
  });

  test('real undici connector rejects a rebinding answer after a successful public preflight', async () => {
    const resolve = jest.fn().mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce(['127.0.0.1']);
    await expect(assertOutboundUrl('http://cdn.example.org/', { resolve })).resolves.toMatchObject({ ok: true });
    const dispatcher = createGuardedDispatcher({ resolve });
    try {
      await expect(request('http://cdn.example.org/', { dispatcher, signal: AbortSignal.timeout(2000) })).rejects.toMatchObject({ code: 'ERR_OUTBOUND_BLOCKED' });
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally { await dispatcher.close(); }
  });
});
