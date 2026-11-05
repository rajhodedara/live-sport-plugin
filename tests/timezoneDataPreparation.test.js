'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareTimezoneData, verifyDirectory, readBoundedBody, downloadPinnedFile, verifyCandidateRuntime } = require('../scripts/prepare-timezone-data.cjs');
const pinned = require('../config/timezone-data.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const license = 'A test license notice.\n';
const fixture = {
  version: '2026f',
  files: ['metaZones.res', 'timezoneTypes.res', 'windowsZones.res', 'zoneinfo64.res'].map(name => {
    const data = Buffer.from(`verified fixture ${name}`);
    return { name, bytes: data.length, sha256: sha256(data) };
  }),
  license: { text: license, sha256: sha256(license) }
};
const content = item => Buffer.from(`verified fixture ${item.name}`);
const verifiedRuntime = { runtime: { node: 'test', tz: '2026f' }, cases: 70 };
let parent;
let directory;

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'timezone-prepare-test-'));
  directory = path.join(parent, '2026f-le');
});
afterEach(async () => { await fs.rm(parent, { recursive: true, force: true }); });

function options(extra = {}) {
  return { directory, manifest: fixture, download: jest.fn(async item => content(item)),
    verifyRuntime: jest.fn(async () => verifiedRuntime), endianness: 'LE', ...extra };
}

test('published manifest pins all official files, their sizes, and the license', () => {
  expect(pinned.files).toHaveLength(4);
  expect(pinned.files.reduce((sum, item) => sum + item.bytes, 0)).toBe(234480);
  for (const item of pinned.files) {
    expect(item.url).toContain(`/unicode-org/icu-data/${pinned.commit}/`);
    expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(sha256(pinned.license.text)).toBe(pinned.license.sha256);
});

test('publishes complete verified data, preserves the license and reuses it offline', async () => {
  const opts = options();
  const report = await prepareTimezoneData(opts);
  expect(report).toMatchObject({ status: 'PASS', reused: false, directory, cases: 70 });
  expect(opts.download).toHaveBeenCalledTimes(4);
  expect((await fs.lstat(directory)).isSymbolicLink()).toBe(true);
  await verifyDirectory(directory, fixture);
  expect(await fs.readFile(path.join(directory, 'LICENSE'), 'utf8')).toBe(license);
  const before = await fs.readlink(directory);
  const noNetwork = options({ checkOnly: true, download: jest.fn(() => { throw new Error('network forbidden'); }) });
  expect(await prepareTimezoneData(noNetwork)).toMatchObject({ reused: true });
  expect(noNetwork.download).not.toHaveBeenCalled();
  expect(await fs.readlink(directory)).toBe(before);
});

test('offline check never prepares missing data', async () => {
  const opts = options({ checkOnly: true });
  await expect(prepareTimezoneData(opts)).rejects.toThrow('TIMEZONE_DATA_NOT_PREPARED');
  expect(opts.download).not.toHaveBeenCalled();
  expect(await fs.readdir(parent)).toEqual([]);
});

test.each(['oversize', 'hash', 'network', 'runtime'])('a %s failure publishes nothing and removes its staging data', async kind => {
  const opts = options();
  if (kind === 'oversize') opts.download = async item => Buffer.concat([content(item), Buffer.from('extra')]);
  if (kind === 'hash') opts.download = async item => Buffer.alloc(item.bytes);
  if (kind === 'network') opts.download = async () => { throw new Error('mock unavailable'); };
  if (kind === 'runtime') opts.verifyRuntime = async () => { throw new Error('TIMEZONE_RUNTIME_CHECK_FAILED'); };
  await expect(prepareTimezoneData(opts)).rejects.toThrow();
  expect(await fs.readdir(parent)).toEqual([]);
});

test('a corrupt existing target is never overwritten or downloaded again', async () => {
  await prepareTimezoneData(options());
  const filename = path.join(directory, fixture.files[0].name);
  await fs.writeFile(filename, Buffer.alloc(fixture.files[0].bytes));
  const before = await fs.readlink(directory);
  const opts = options();
  await expect(prepareTimezoneData(opts)).rejects.toThrow('TIMEZONE_DATA_HASH_MISMATCH');
  expect(opts.download).not.toHaveBeenCalled();
  expect(opts.verifyRuntime).not.toHaveBeenCalled();
  expect(await fs.readlink(directory)).toBe(before);
  expect(await fs.readFile(filename)).toEqual(Buffer.alloc(fixture.files[0].bytes));
});

test('existing file symlinks are rejected instead of accepting independently mutable content', async () => {
  await prepareTimezoneData(options());
  const filename = path.join(directory, fixture.files[0].name);
  const other = path.join(parent, 'elsewhere');
  await fs.rename(filename, other);
  await fs.symlink(other, filename);
  await expect(prepareTimezoneData(options({ checkOnly: true }))).rejects.toThrow('TIMEZONE_DATA_SIZE_MISMATCH');
});

test('an empty directory appearing at publication is preserved, never replaced by rename', async () => {
  const opts = options({ verifyRuntime: async () => {
    await fs.mkdir(directory);
    return verifiedRuntime;
  } });
  await expect(prepareTimezoneData(opts)).rejects.toThrow();
  expect((await fs.lstat(directory)).isDirectory()).toBe(true);
  expect(await fs.readdir(directory)).toEqual([]);
  expect(await fs.readdir(parent)).toEqual(['2026f-le']);
});

test('two concurrent preparers share the winning complete directory and clean only unused staging', async () => {
  const reports = await Promise.all([prepareTimezoneData(options()), prepareTimezoneData(options())]);
  expect(reports.map(item => item.reused).sort()).toEqual([false, true]);
  await verifyDirectory(directory, fixture);
  const retained = await fs.realpath(directory);
  const children = await fs.readdir(parent);
  expect(children.sort()).toEqual(['2026f-le', path.basename(retained)].sort());
});

test('unsupported endianness and relative targets fail before preparation', async () => {
  await expect(prepareTimezoneData(options({ endianness: 'BE' }))).rejects.toThrow('UNSUPPORTED_ICU_DATA_ENDIANNESS');
  await expect(prepareTimezoneData(options({ directory: './relative' }))).rejects.toThrow('TIMEZONE_DIRECTORY_MUST_BE_ABSOLUTE');
  expect(await fs.readdir(parent)).toEqual([]);
});

test('streamed downloads enforce a byte bound while reading', async () => {
  async function* body() { yield Buffer.alloc(8); yield Buffer.alloc(8); }
  await expect(readBoundedBody(body(), 10)).rejects.toThrow('TIMEZONE_DATA_SIZE_MISMATCH');
  expect(await readBoundedBody(body(), 16)).toHaveLength(16);
});

test('HTTP failures abort an unread response and destroy the owned dispatcher without waiting for graceful close', async () => {
  const dispatcher = { close: jest.fn(() => new Promise(() => {})), destroy: jest.fn(async () => {}) };
  let signal;
  const fetchImpl = async (_url, options) => {
    signal = options.signal;
    return { ok: false, body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } };
  };
  await expect(downloadPinnedFile(fixture.files[0], { fetchImpl, createDispatcher: () => dispatcher })).rejects.toThrow('TIMEZONE_DATA_HTTP_ERROR');
  expect(signal.aborted).toBe(true);
  expect(dispatcher.destroy).toHaveBeenCalledTimes(1);
  expect(dispatcher.close).not.toHaveBeenCalled();
});

test('oversized bodies destroy the owned dispatcher and cleanup errors do not mask the safe failure', async () => {
  const dispatcher = { destroy: jest.fn(async () => { throw new Error('private cleanup details'); }) };
  const fetchImpl = async () => ({ ok: true, body: (async function* () { yield Buffer.alloc(200); })() });
  await expect(downloadPinnedFile(fixture.files[0], { fetchImpl, createDispatcher: () => dispatcher })).rejects.toThrow('TIMEZONE_DATA_SIZE_MISMATCH');
  expect(dispatcher.destroy).toHaveBeenCalledTimes(1);
});

test('candidate validation uses the invoking executable and requires that ICU actually loaded the pinned release', () => {
  const spawn = jest.fn(() => ({ status: 0, stdout: JSON.stringify({ status: 'PASS', failures: 0, cases: 70, runtime: { tz: '2026f' } }) }));
  expect(verifyCandidateRuntime(directory, '2026f', spawn)).toMatchObject({ runtime: { tz: '2026f' }, cases: 70 });
  expect(spawn).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('check-timezone-runtime.cjs')], expect.objectContaining({
    timeout: 15000, maxBuffer: 1024 * 1024, env: expect.objectContaining({ ICU_TIMEZONE_FILES_DIR: directory })
  }));
  spawn.mockReturnValue({ status: 0, stdout: JSON.stringify({ status: 'PASS', failures: 0, cases: 70, runtime: { tz: '2026e' } }) });
  expect(() => verifyCandidateRuntime(directory, '2026f', spawn)).toThrow('TIMEZONE_RUNTIME_CHECK_FAILED');
});
