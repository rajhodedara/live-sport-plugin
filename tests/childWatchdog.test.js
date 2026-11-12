'use strict';

const { startChildWatchdog, LOCAL_TIMEOUT_EXIT_CODE, LOCAL_CANCELLED_EXIT_CODE } = require('../src/providers/PpvStWasmExit');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startChildWatchdog', () => {
  test('exits with the timeout code once the lifetime is exceeded', async () => {
    const codes = [];
    startChildWatchdog({ maxLifetimeMs: 20, pollMs: 1000, getParentPid: () => 10, exit: (c) => codes.push(c) });
    await sleep(60);
    expect(codes[0]).toBe(LOCAL_TIMEOUT_EXIT_CODE);
  });

  test('exits with the cancelled code when the parent pid changes', async () => {
    const codes = [];
    let parent = 10;
    startChildWatchdog({ maxLifetimeMs: 1000, pollMs: 5, getParentPid: () => parent, exit: (c) => codes.push(c) });
    await sleep(20);
    expect(codes.length).toBe(0);
    parent = 1;
    await sleep(30);
    expect(codes[0]).toBe(LOCAL_CANCELLED_EXIT_CODE);
  });

  test('stopping the watchdog cancels both timers', async () => {
    const codes = [];
    const stop = startChildWatchdog({ maxLifetimeMs: 20, pollMs: 5, getParentPid: () => 10, exit: (c) => codes.push(c) });
    stop();
    await sleep(60);
    expect(codes.length).toBe(0);
  });

  test('uses the real parent pid by default and stays quiet while it is unchanged', async () => {
    const codes = [];
    const stop = startChildWatchdog({ maxLifetimeMs: 1000, pollMs: 5, exit: (c) => codes.push(c) });
    await sleep(30);
    stop();
    expect(codes.length).toBe(0);
  });
});
