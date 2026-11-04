'use strict';

// Child extractors are copied flat to the build root, unlike the source tree.
// Resolve their actual import expression in both layouts without starting WASM.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const sourceDir = path.resolve(__dirname, '../src/providers');
const names = [
  'run_gasm_india.js', 'run_gasm_native.js', 'run_gasm_native_exports.js',
  'run_gasm_native_imports.js', 'run_gasm_native_india.js',
  'run_gasm_native_india_hook.js', 'run_gasm_native_india_mock.js',
  'run_gasm_native_proxy.js', 'run_wasm_native.js'
];

let buildDir;
beforeAll(() => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-child-import-'));
  fs.mkdirSync(path.join(buildDir, 'services'));
  fs.writeFileSync(path.join(buildDir, 'services/ProviderOutbound.js'), 'module.exports = {};');
  for (const name of names) fs.copyFileSync(path.join(sourceDir, name), path.join(buildDir, name));
});
afterAll(() => fs.rmSync(buildDir, { recursive: true, force: true }));

test.each(names)('%s resolves ProviderOutbound in both source and built layouts', name => {
  for (const dir of [sourceDir, buildDir]) {
    const file = path.join(dir, name);
    const code = fs.readFileSync(file, 'utf8');
    const match = code.match(/(?:const outboundPath =|require\()\s*(fs\.existsSync\(path\.join\(__dirname, 'services', 'ProviderOutbound\.js'\)\)\s*\? '\.\/services\/ProviderOutbound'\s*:\s*'\.\.\/services\/ProviderOutbound')/);
    expect(match).not.toBeNull();
    const specifier = vm.runInNewContext(match[1], { fs, path, __dirname: dir });
    const expected = dir === sourceDir
      ? path.resolve(sourceDir, '../services/ProviderOutbound.js')
      : path.join(buildDir, 'services/ProviderOutbound.js');
    expect(createRequire(file).resolve(specifier)).toBe(expected);
  }
});
