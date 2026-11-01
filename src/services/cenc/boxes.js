/**
 * cenc/boxes.js — minimal ISO BMFF (ISO/IEC 14496-12) box reader/writer.
 *
 * Deliberately dumb: no box is parsed into an object graph, everything is a
 * view over the caller's Buffer. That keeps the hot path (a 2 MB segment with
 * ~300 samples) allocation-free except for the box descriptors themselves.
 *
 * All accessors are bounds-checked and return null instead of throwing; the
 * callers (init.js / segment.js) decide whether a missing box is fatal.
 */

'use strict';

const FREE = 'free';

function u32(buf, off) {
  return buf.readUInt32BE(off);
}

function type4(buf, off) {
  return buf.toString('latin1', off, off + 4);
}

/**
 * Reads one box header at `off`.
 * @returns {{type:string,size:number,start:number,body:number,end:number}|null}
 *   `body` is the first byte after the header, `end` is `start + size`.
 */
function readBox(buf, off, end) {
  if (off + 8 > end) return null;
  let size = buf.readUInt32BE(off);
  const type = type4(buf, off + 4);
  let headerSize = 8;

  if (size === 1) {
    // 64-bit largesize — only seen on >4 GiB mdat in practice, but valid.
    if (off + 16 > end) return null;
    const hi = buf.readUInt32BE(off + 8);
    const lo = buf.readUInt32BE(off + 12);
    size = hi * 2 ** 32 + lo;
    headerSize = 16;
  } else if (size === 0) {
    // Extends to the end of the enclosing container / file.
    size = end - off;
  }

  if (size < headerSize || off + size > end) return null;
  return { type, size, start: off, body: off + headerSize, end: off + size };
}

/** Iterates the direct children of [start, end). */
function* children(buf, start, end) {
  let off = start;
  while (off + 8 <= end) {
    const box = readBox(buf, off, end);
    if (!box) return;
    yield box;
    off = box.end;
  }
}

function findChild(buf, parent, type) {
  if (!parent) return null;
  for (const child of children(buf, parent.body, parent.end)) {
    if (child.type === type) return child;
  }
  return null;
}

function findChildren(buf, parent, type) {
  const out = [];
  if (!parent) return out;
  for (const child of children(buf, parent.body, parent.end)) {
    if (child.type === type) out.push(child);
  }
  return out;
}

/** First top-level box of `type`. */
function findTop(buf, type) {
  return findChild(buf, { body: 0, end: buf.length }, type);
}

function findTops(buf, type) {
  return findChildren(buf, { body: 0, end: buf.length }, type);
}

/**
 * Depth-first collection of every descendant named `type`, at any level.
 * Used for box hygiene (masking `senc`/`saiz`/`saio`/`sgpd` wherever they sit).
 */
function collect(buf, parent, types, out = []) {
  const wanted = typeof types === 'string' ? new Set([types]) : new Set(types);
  if (!parent) return out;
  for (const child of children(buf, parent.body, parent.end)) {
    if (wanted.has(child.type)) out.push(child);
    // Containers we never need to descend into: leaves and mdat-sized blobs.
    if (child.type === 'mdat' || child.type === 'free' || child.type === 'skip') continue;
    collect(buf, child, wanted, out);
  }
  return out;
}

/** Rewrites a box type in place. Size, position and payload are untouched. */
function writeType(buf, box, type) {
  buf.write(type, box.start + 4, 4, 'latin1');
}

/** Version byte of a FullBox. */
function version(buf, box) {
  return box && box.body < box.end ? buf[box.body] : 0;
}

/** 24-bit flags of a FullBox. */
function flags(buf, box) {
  return box && box.body + 4 <= box.end ? buf.readUIntBE(box.body + 1, 3) : 0;
}

module.exports = {
  FREE,
  readBox,
  children,
  findChild,
  findChildren,
  findTop,
  findTops,
  collect,
  writeType,
  version,
  flags,
  u32,
  type4
};
