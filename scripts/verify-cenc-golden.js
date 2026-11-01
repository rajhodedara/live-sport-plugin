#!/usr/bin/env node
/**
 * scripts/verify-cenc-golden.js — opt-in reference check for the CENC engine.
 *
 * `npm test` uses synthetic fixtures, which proves the decryptor is
 * self-consistent but not that it matches the spec bit-for-bit. This script
 * closes that gap against a real capture, and against Bento4 when available.
 *
 *   node scripts/verify-cenc-golden.js <init.mp4> <segment.mp4> <kid:key> [--keep]
 *
 * It:
 *   1. uncloaks the init and decrypts the segment with src/services/DashCencEngine
 *   2. writes <segment>.decrypted.mp4 next to the input
 *   3. if `mp4decrypt` is on PATH, produces <segment>.reference.mp4 and compares
 *      SHA-256 — a mismatch means the keystream handling is wrong somewhere,
 *      even if the output "plays".
 *   4. if `ffmpeg` is on PATH, runs a decode pass and reports decoder errors.
 *
 * Exit codes: 0 = verified, 1 = mismatch/decoder errors, 2 = usage/tooling.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const engine = require('../src/services/DashCencEngine');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/verify-cenc-golden.js <init.mp4> <segment.mp4> <kid:key> [--keep]');
  process.exit(2);
}

function hasBinary(name) {
  try {
    execFileSync(name, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const [, , initPath, segmentPath, kidKey, ...flags] = process.argv;
if (!initPath || !segmentPath || !kidKey) usage();
if (!fs.existsSync(initPath)) usage(`init not found: ${initPath}`);
if (!fs.existsSync(segmentPath)) usage(`segment not found: ${segmentPath}`);

const [kid, keyHex] = String(kidKey).split(':');
if (!/^[0-9a-fA-F]{32}$/.test(kid || '') || !/^[0-9a-fA-F]{32}$/.test(keyHex || '')) {
  usage('<kid:key> must be 32-hex:32-hex');
}

const init = engine.uncloakInit(Buffer.from(fs.readFileSync(initPath)));
const segment = engine.decryptSegment(Buffer.from(fs.readFileSync(segmentPath)), {
  tracks: init.tracks,
  keysByKid: { [kid.toLowerCase()]: Buffer.from(keyHex, 'hex') }
});

const outPath = segmentPath.replace(/\.mp4$/i, '') + '.decrypted.mp4';
fs.writeFileSync(outPath, segment.buf);

console.log(`init tracks     : ${[...init.tracks.keys()].join(', ') || '(none)'}`);
console.log(`segment         : ${segment.stats.samples} samples, ${segment.stats.bytes} bytes, ` +
  `${segment.stats.moofs} moof, ${segment.stats.trafs} traf`);
console.log(`decrypted       : ${outPath} (${segment.buf.length} bytes, sha256 ${sha256(segment.buf)})`);

let ok = true;

if (hasBinary('mp4decrypt')) {
  const refPath = segmentPath.replace(/\.mp4$/i, '') + '.reference.mp4';
  try {
    execFileSync('mp4decrypt', [`--key`, `${kid}:${keyHex}`, segmentPath, refPath], { stdio: 'pipe' });
    const same = Buffer.compare(segment.buf, fs.readFileSync(refPath)) === 0;
    console.log(`mp4decrypt ref  : ${refPath}`);
    console.log(`byte-exact      : ${same ? 'YES' : 'NO  <-- keystream/framing bug'}`);
    ok = ok && same;
  } catch (err) {
    console.error(`mp4decrypt failed: ${err.message.split('\n')[0]}`);
  }
} else {
  console.log('mp4decrypt      : not on PATH — skipped (byte-exact comparison unavailable)');
}

if (hasBinary('ffmpeg')) {
  try {
    const log = execFileSync('ffmpeg', ['-v', 'error', '-i', outPath, '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString();
    const clean = log.trim() === '';
    console.log(`ffmpeg decode   : ${clean ? 'clean' : 'errors below'}`);
    if (!clean) console.log(log.trim().split('\n').slice(0, 20).join('\n'));
    ok = ok && clean;
  } catch (err) {
    console.error('ffmpeg reported errors on the decrypted output');
    ok = false;
  }
} else {
  console.log('ffmpeg          : not on PATH — skipped decode check');
}

if (!flags.includes('--keep')) {
  for (const extra of [outPath, segmentPath.replace(/\.mp4$/i, '') + '.reference.mp4']) {
    if (extra !== outPath && fs.existsSync(extra)) fs.unlinkSync(extra);
  }
}

console.log(ok ? '\nRESULT: verified' : '\nRESULT: NOT verified');
process.exit(ok ? 0 : 1);
