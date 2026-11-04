'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real jwplayer hook without starting a child, WASM or networking.
function setupHarness() {
  const script = fs.readFileSync(path.join(__dirname, '../src/providers/run_gasm_india.js'), 'utf8');
  const start = script.indexOf('global.window.jwplayer = function()');
  const end = script.indexOf('global.screen =', start);
  if (start < 0 || end < 0) throw new Error('jwplayer hook not found');
  const writes = [], exits = [];
  const processStub = { stdout: { write: (text, done) => writes.push({ text, done }) }, exit: code => exits.push(code) };
  const context = { global: { window: {} }, process: processStub };
  vm.runInNewContext(script.slice(start, end), context);
  return { player: context.global.window.jwplayer(), writes, exits };
}

test('a playlist is delivered before the child exits successfully', () => {
  const { player, writes, exits } = setupHarness();
  player.setup({ file: 'https://cdn.example.test/live.m3u8?token=fixture' });
  expect(writes[0].text).toMatch(/"file":\s*"https:\/\/cdn\.example\.test\/live\.m3u8\?token=fixture"/);
  expect(exits).toEqual([]);
  writes[0].done();
  expect(exits).toEqual([0]);
});

test.each([{}, { file: 'https://cdn.example.test/video.mp4' }, { file: '/live.m3u8' }, { file: 'file:///live.m3u8' }])('does not finish for a non-playlist setup %#', config => {
  const { player, writes, exits } = setupHarness();
  player.setup(config);
  writes[0].done();
  expect(exits).toEqual([]);
});

test('does not report success when writing the result fails', () => {
  const { player, writes, exits } = setupHarness();
  player.setup({ file: 'https://cdn.example.test/live.m3u8' });
  writes[0].done(new Error('write failed'));
  expect(exits).toEqual([]);
});
