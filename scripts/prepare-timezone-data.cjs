'use strict';

// Explicit maintenance command only. The addon never downloads timezone data.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const pinned = require('../config/timezone-data.json');
const root = path.resolve(__dirname, '..');
const defaultDirectory = path.join(root, '.timezone-data', `${pinned.version}-le`);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const failure = code => new Error(code);

function entries(manifest) {
  const license = Buffer.from(manifest.license.text, 'utf8');
  if (digest(license) !== manifest.license.sha256) throw failure('INVALID_PINNED_LICENSE');
  return [...manifest.files, { name: 'LICENSE', bytes: license.length, sha256: manifest.license.sha256, data: license }];
}

async function readBoundedBody(body, maxBytes) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw failure('INVALID_DATA_RESPONSE');
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.byteLength;
    if (length > maxBytes) throw failure('TIMEZONE_DATA_SIZE_MISMATCH');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, length);
}

async function downloadPinnedFile(item, { fetchImpl, createDispatcher, timeoutMs = 20000 } = {}) {
  if (!fetchImpl || !createDispatcher) {
    const undici = require('undici');
    fetchImpl ||= undici.fetch;
    createDispatcher ||= () => new undici.EnvHttpProxyAgent();
  }
  const dispatcher = createDispatcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(item.url, { dispatcher, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw failure('TIMEZONE_DATA_HTTP_ERROR');
    return await readBoundedBody(response.body, item.bytes);
  } catch (error) {
    if (controller.signal.aborted) throw failure('TIMEZONE_DATA_TIMEOUT');
    if (/^TIMEZONE_DATA_|^INVALID_DATA_RESPONSE$/.test(error.message)) throw error;
    throw failure('TIMEZONE_DATA_DOWNLOAD_FAILED');
  } finally {
    clearTimeout(timer);
    // An HTTP error can leave its body unread. Graceful close waits for that
    // body indefinitely, so abort and destroy this command-owned dispatcher.
    controller.abort();
    try { await dispatcher.destroy(); } catch (_) { /* preserve the bounded, sanitized result */ }
  }
}

function verifyBytes(data, item) {
  if (!Buffer.isBuffer(data) || data.length !== item.bytes) throw failure('TIMEZONE_DATA_SIZE_MISMATCH');
  if (digest(data) !== item.sha256) throw failure('TIMEZONE_DATA_HASH_MISMATCH');
}

async function readPinnedFile(filename, item) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.size !== item.bytes) throw failure('TIMEZONE_DATA_SIZE_MISMATCH');
  const file = await fs.open(filename, 'r');
  try {
    const data = Buffer.alloc(item.bytes + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    verifyBytes(data.subarray(0, length), item);
  } finally { await file.close(); }
}

async function verifyDirectory(directory, manifest = pinned) {
  for (const item of entries(manifest)) await readPinnedFile(path.join(directory, item.name), item);
}

function verifyCandidateRuntime(directory, version = pinned.version, spawn = spawnSync) {
  // ICU reads this variable at process initialization, so use a fresh process
  // with the exact executable that invoked preparation. This imports no addon.
  const child = spawn(process.execPath, [path.join(__dirname, 'check-timezone-runtime.cjs')], {
    env: { ...process.env, ICU_TIMEZONE_FILES_DIR: directory },
    encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  let report;
  try { report = JSON.parse(child.stdout); } catch (_) { /* bounded generic error below */ }
  if (child.error || child.status !== 0 || report?.status !== 'PASS' || report?.failures !== 0 ||
      !Number.isInteger(report?.cases) || report.cases < 1 || report?.runtime?.tz !== version) {
    throw failure('TIMEZONE_RUNTIME_CHECK_FAILED');
  }
  return { runtime: report.runtime, cases: report.cases };
}

async function pathExists(directory) {
  try { await fs.lstat(directory); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function prepareTimezoneData({ directory = defaultDirectory, checkOnly = false,
  manifest = pinned, download = downloadPinnedFile, verifyRuntime = verifyCandidateRuntime,
  endianness = os.endianness() } = {}) {
  if (endianness !== 'LE') throw failure('UNSUPPORTED_ICU_DATA_ENDIANNESS');
  if (!path.isAbsolute(directory)) throw failure('TIMEZONE_DIRECTORY_MUST_BE_ABSOLUTE');
  if (await pathExists(directory)) {
    await verifyDirectory(directory, manifest);
    const runtime = await verifyRuntime(directory, manifest.version);
    return { status: 'PASS', version: manifest.version, directory, reused: true, ...runtime };
  }
  if (checkOnly) throw failure('TIMEZONE_DATA_NOT_PREPARED');

  await fs.mkdir(path.dirname(directory), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(directory), `.${manifest.version}-verified-`));
  let published = false;
  try {
    // The resources contain public timezone data and may be read by a distinct
    // application account after an operator prepares the candidate as root.
    await fs.chmod(staging, 0o755);
    for (const item of entries(manifest)) {
      const data = item.data || await download(item);
      verifyBytes(data, item);
      await fs.writeFile(path.join(staging, item.name), data, { flag: 'wx', mode: 0o644 });
    }
    await verifyDirectory(staging, manifest);
    const runtime = await verifyRuntime(staging, manifest.version);
    // Exclusive symlink/junction creation publishes the complete immutable
    // directory atomically. Unlike rename(), it cannot replace an empty target
    // directory created by another preparer between checking and publication.
    try { await fs.symlink(staging, directory, 'junction'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await verifyDirectory(directory, manifest);
      const winner = await verifyRuntime(directory, manifest.version);
      return { status: 'PASS', version: manifest.version, directory, reused: true, ...winner };
    }
    published = true;
    return { status: 'PASS', version: manifest.version, directory, reused: false, ...runtime };
  } finally {
    if (!published) await fs.rm(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let directory = defaultDirectory;
  let checkOnly = false;
  let invalid = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') checkOnly = true;
    else if (args[i] === '--directory' && args[i + 1]) directory = args[++i];
    else invalid = true;
  }
  if (invalid) {
    console.error('Usage: node scripts/prepare-timezone-data.cjs [--check] [--directory ABSOLUTE_PATH]');
    process.exitCode = 2;
  } else {
    prepareTimezoneData({ directory, checkOnly }).then(report => {
      console.log(JSON.stringify(report, null, 2));
    }).catch(error => {
      const reason = /^(TIMEZONE_|UNSUPPORTED_ICU_|INVALID_PINNED_)/.test(error.message) ? error.message : 'TIMEZONE_DATA_PREPARATION_FAILED';
      console.error(JSON.stringify({ status: 'FAIL', reason,
        action: 'Keep the running application unchanged. Verify the candidate directory, supported Node/ICU runtime and official-source network access, then retry preparation.' }));
      process.exitCode = 1;
    });
  }
}

module.exports = { prepareTimezoneData, verifyDirectory, verifyCandidateRuntime, downloadPinnedFile, readBoundedBody, defaultDirectory };
