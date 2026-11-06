'use strict';

// Execute only the actual child fetch-hook function with a mocked transport.
// The surrounding child/WASM bootstrap is parsed, never executed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const {
  LOCAL_CAPACITY_EXIT_CODE, LOCAL_TIMEOUT_EXIT_CODE, LOCAL_CANCELLED_EXIT_CODE,
  wasmFailureExitCode
} = require('../src/providers/PpvStWasmExit');

const filename = path.join(__dirname, '../src/providers/run_gasm_india.js');
const source = fs.readFileSync(filename, 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
const fetchHook = ast.body.filter(node => node.type === 'ExpressionStatement' &&
  node.expression.type === 'AssignmentExpression' &&
  node.expression.left.type === 'MemberExpression' &&
  node.expression.left.object.name === 'global' && node.expression.left.property.name === 'fetch').at(-1).expression.right;

function runFetchHook(error) {
  const fetch = jest.fn(async () => { throw error; });
  const exit = jest.fn(code => { throw Object.assign(new Error('mock child exit'), { exitCode: code }); });
  const hook = vm.runInNewContext('(' + source.slice(fetchHook.start, fetchHook.end) + ')', {
    gasmSafeFetch: fetch, wasmFailureExitCode, Headers, Response, Buffer,
    targetOrigin: 'https://embed.fixture.test', fullEmbedUrl: 'https://embed.fixture.test/embed/channel',
    process: { exit }, console: { log() {}, error() {} },
    fs: { readFileSync() { throw new Error('WASM must not load in this test'); } }, path
  }, { filename: 'ppv-child-fetch-hook.fixture.js' });
  return { call: hook('https://embed.fixture.test/fetch', { body: Buffer.from('fixture') }), fetch, exit };
}

describe('actual PPV child fetch hook private error protocol', () => {
  test.each([
    [{ code: 'ERR_NATIVE_POOL_BUSY' }, LOCAL_CAPACITY_EXIT_CODE],
    [{ name: 'TimeoutError' }, LOCAL_TIMEOUT_EXIT_CODE],
    [{ cause: { code: 'UND_ERR_BODY_TIMEOUT' } }, LOCAL_TIMEOUT_EXIT_CODE],
    [{ name: 'AbortError' }, LOCAL_CANCELLED_EXIT_CODE],
    [{ name: 'TimeoutError', cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } }, 1],
    [{ code: 'ERR_NATIVE_POOL_BUSY', cause: { code: 'ERR_OUTBOUND_BLOCKED', isFatal: true } }, 1],
    [{ message: 'ordinary WASM failure', statusCode: 503 }, 1]
  ])('typed child transport failure %j exits with %i', async (error, code) => {
    const fixture = runFetchHook(error);
    await expect(fixture.call).rejects.toMatchObject({ exitCode: code });
    expect(fixture.exit).toHaveBeenCalledTimes(1);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
});
