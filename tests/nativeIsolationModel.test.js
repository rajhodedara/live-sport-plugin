'use strict';
const { createIsolationModel } = require('./fixtures/native-isolation-model.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const request = { profile: 'vanilla', proxyUrl: 'socks5://127.0.0.1:40000' };

test('a canceled hung operation is replaced only after termination is confirmed', async () => {
  let confirmExit;
  const launch = jest.fn(() => ({ result: new Promise(() => {}), terminate: jest.fn(() => new Promise(resolve => { confirmExit = resolve; })) }));
  const model = createIsolationModel(launch, 1), controller = new AbortController();
  const pending = model.run(request, { signal: controller.signal });
  controller.abort(new Error('deadline'));
  await expect(pending).rejects.toThrow('deadline');
  await tick();
  expect(model.occupied).toBe(1);
  await expect(model.run(request, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  confirmExit(); await tick();
  expect(model.occupied).toBe(0);
  expect(launch).toHaveBeenCalledWith(request);
});

test('unconfirmed or failed termination never frees capacity', async () => {
  const model = createIsolationModel(() => ({ result: Promise.resolve('ok'), terminate: async () => { throw Error('exit not confirmed'); } }), 1);
  await expect(model.run(request, { signal: new AbortController().signal })).resolves.toBe('ok');
  await tick();
  expect(model.occupied).toBe(1);
  await expect(model.run(request, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
});

test('four hung operations never admit a fifth before an exit is confirmed', async () => {
  const exits = [];
  const model = createIsolationModel(() => ({ result: new Promise(() => {}), terminate: () => new Promise(resolve => exits.push(resolve)) }));
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const jobs = controllers.map(controller => model.run(request, { signal: controller.signal }).catch(error => error));
  controllers.forEach(controller => controller.abort(new Error('deadline')));
  await Promise.all(jobs); await tick();
  expect(model.occupied).toBe(4);
  await expect(model.run(request, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'ERR_NATIVE_POOL_BUSY' });
  exits[0](); await tick();
  expect(model.occupied).toBe(3);
  exits.slice(1).forEach(exit => exit()); await tick();
  expect(model.occupied).toBe(0);
});
