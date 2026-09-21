'use strict';

/**
 * Poster reference integrity.
 *
 * public/posters was deduplicated down to eight canonical files. A stale string
 * reference to a deleted path is silent at runtime - it just serves a 404 or the
 * SVG fallback - so these tests fail loudly if any source reference drifts from
 * what is actually on disk.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POSTER_DIR = path.join(ROOT, 'public', 'posters');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'dist_wasm', 'DELIVERY', 'docs', 'tests'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(js|mjs|cjs|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Every logical "/posters/..." path referenced from source. */
function referencedPosterPaths() {
  const refs = new Map();
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\/posters\/[A-Za-z0-9_\-/]+\.(?:jpg|jpeg|png|webp)/g)) {
      const logical = m[0];
      if (!refs.has(logical)) refs.set(logical, []);
      refs.get(logical).push(path.relative(ROOT, file).replace(/\\/g, '/'));
    }
  }
  return refs;
}

describe('poster asset integrity', () => {
  test('the deduplicated poster set is exactly the eight canonical files', () => {
    const files = [];
    (function walkPosters(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkPosters(p);
        else if (/\.(jpg|jpeg|png)$/i.test(e.name)) files.push(p);
      }
    })(POSTER_DIR);

    expect(files.length).toBe(8);
    for (const f of files) {
      expect(path.basename(f)).toMatch(/^luffy_/);
    }
    // The duplicated collections/ folder must be gone entirely.
    expect(fs.existsSync(path.join(POSTER_DIR, 'collections'))).toBe(false);
  });

  test('every poster path referenced in source exists on disk', () => {
    const missing = [];
    for (const [logical, files] of referencedPosterPaths()) {
      const onDisk = path.join(ROOT, 'public', logical);
      if (!fs.existsSync(onDisk)) missing.push(logical + '   <- ' + files.join(', '));
    }
    expect(missing).toEqual([]);
  });

  test('the removed duplicate paths are not referenced anywhere', () => {
    const removed = [
      '/posters/replays/football.jpg',
      '/posters/replays/basketball.jpg',
      '/posters/replays/hockey.jpg',
      '/posters/replays/tennis.jpg',
      '/posters/replays/rugby.jpg',
      '/posters/replays/baseball.jpg',
      '/posters/replays/motorsport.jpg',
      '/posters/replays/american_football.jpg',
      '/posters/collections/football.jpg'
    ];
    const refs = referencedPosterPaths();
    const stale = [];
    for (const r of removed) {
      // Guard against a longer path merely containing this one as a prefix.
      for (const logical of refs.keys()) {
        if (logical === r) stale.push(logical + '   <- ' + refs.get(logical).join(', '));
      }
    }
    expect(stale).toEqual([]);
  });

  test('every REPLAY_SPORTS poster points at a real file', () => {
    const { REPLAY_SPORTS } = require('../src/catalog');
    expect(REPLAY_SPORTS.length).toBe(9);
    for (const s of REPLAY_SPORTS) {
      const clean = s.poster.split('?')[0];
      expect(fs.existsSync(path.join(ROOT, 'public', clean))).toBe(true);
    }
  });

  test('no two REPLAY_SPORTS entries share the same artwork', () => {
    const { REPLAY_SPORTS } = require('../src/catalog');
    const byPath = new Map();
    for (const s of REPLAY_SPORTS) {
      const clean = s.poster.split('?')[0];
      if (!byPath.has(clean)) byPath.set(clean, []);
      byPath.get(clean).push(s.id);
    }
    // "all" intentionally reuses the football cover; every sport must differ.
    const dupes = [...byPath.entries()].filter(([, ids]) => ids.filter((i) => i !== 'all').length > 1);
    expect(dupes).toEqual([]);
  });
});
