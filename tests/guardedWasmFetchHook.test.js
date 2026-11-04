'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');

// Evaluate only the actual request-hook function, never the worker bootstrap,
// WASM loader, remote provider or worker pool. Transport is a strict stub.
function hook(guardedFetch) {
  const source = fs.readFileSync(path.join(__dirname, '../src/providers/streamed_wasm_worker.js'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const assignment = ast.body.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
    node.expression.left.type === 'MemberExpression' && node.expression.left.object.name === 'global' && node.expression.left.property.name === 'fetch').expression;
  const context = vm.createContext({ Buffer, Headers, Response, guardedFetch, targetOrigin: 'https://embed.example.org',
    fullEmbedUrl: 'https://embed.example.org/watch', capturedGoat: null, OriginalHeadersGet: Headers.prototype.get,
    setTimeout() { throw Error('Unexpected retry on a guard rejection'); } });
  return vm.runInContext('(' + source.slice(assignment.right.start, assignment.right.end) + ')', context);
}

test('the actual WASM hook keeps binary POST and Goat metadata on the guarded vanilla client', async () => {
  const guardedFetch = jest.fn(async () => new Response(Uint8Array.from([0, 1, 255]), { headers: { Goat: 'fixture-proof' } }));
  const response = await hook(guardedFetch)('https://embed.example.org/fetch', { method: 'POST', body: Buffer.from([7, 8]) });
  expect(guardedFetch).toHaveBeenCalledTimes(1);
  expect(guardedFetch.mock.calls[0][0]).toBe('https://embed.example.org/fetch');
  expect(guardedFetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: Buffer.from([7, 8]), profile: 'vanilla', attempts: 1 });
  const headers = new Headers(guardedFetch.mock.calls[0][1].headers);
  expect(headers.get('referer')).toBe('https://embed.example.org/watch');
  expect(response.headers.get('goat')).toBe('fixture-proof');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 1, 255]));
});
test('the WASM hook does not retry a rejected private destination', async () => {
  const failure = Object.assign(new Error('Blocked'), { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true });
  const guardedFetch = jest.fn(async () => { throw failure; });
  await expect(hook(guardedFetch)('https://embed.example.org/fetch', { body: Buffer.from([1]) })).rejects.toBe(failure);
  expect(guardedFetch).toHaveBeenCalledTimes(1);
});
