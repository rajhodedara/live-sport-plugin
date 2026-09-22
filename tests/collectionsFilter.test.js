'use strict';

// Regression guard: the Nuvio Collections JSON must be able to carry the replay
// personalization.
//
// Why this exists: every collection row queries its OWN manifestUrl. If that URL
// carries no config, an imported collection silently ignores the user's replay
// scope — the user picks "Mainstream only", imports the collection, and still
// sees every niche fixture. generateCollections therefore accepts explicit
// options that are merged into the rows' manifestUrl.

const { generateCollections } = require('../src/collections');

function segmentOf(url) {
  const m = String(url).match(/^(.*)\/manifest\.json$/);
  if (!m) return null;
  const last = m[1].split('/').pop();
  return last || null;
}

function decode(segment) {
  let b = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
}

function firstManifestUrl(collections) {
  return collections[0].folders[0].catalogSources[0].manifestUrl;
}

describe('collections JSON carries the replay filter', () => {
  test('no config and no options leaves the bare manifestUrl (unchanged default)', () => {
    const url = firstManifestUrl(generateCollections('https://nuviosports.xyz', ''));
    expect(url).toBe('https://nuviosports.xyz/manifest.json');
  });

  test('replayFilter option is embedded in the rows manifestUrl', () => {
    const url = firstManifestUrl(generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' }));
    const seg = segmentOf(url);
    expect(seg).toBeTruthy();
    expect(decode(seg).replayFilter).toBe('mainstream');
  });

  test('an explicit option merges over an existing config segment', () => {
    const tz = Buffer.from(JSON.stringify({ timezone: 'Asia/Kolkata' }), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = firstManifestUrl(generateCollections('https://nuviosports.xyz', tz, { replayFilter: 'mainstream' }));
    const cfg = decode(segmentOf(url));
    expect(cfg.timezone).toBe('Asia/Kolkata');
    expect(cfg.replayFilter).toBe('mainstream');
  });

  test('languages option is carried too', () => {
    const url = firstManifestUrl(generateCollections('https://nuviosports.xyz', '', { languages: 'Spanish' }));
    expect(decode(segmentOf(url)).languages).toBe('Spanish');
  });

  test('a config segment without options is used verbatim (no accidental rewrite)', () => {
    const tz = Buffer.from(JSON.stringify({ timezone: 'Asia/Kolkata' }), 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = firstManifestUrl(generateCollections('https://nuviosports.xyz', tz));
    expect(url).toBe(`https://nuviosports.xyz/${tz}/manifest.json`);
  });

  test('every row of a folder shares one manifestUrl', () => {
    const collections = generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' });
    const srcs = collections[0].folders[0].catalogSources;
    expect(srcs.length).toBeGreaterThan(1);
    expect(new Set(srcs.map(s => s.manifestUrl)).size).toBe(1);
  });

  test('collection and folder shape is unchanged', () => {
    const collections = generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' });
    expect(Array.isArray(collections)).toBe(true);
    expect(collections[0].id).toBe('collection-sports-replays');
    expect(collections[0].folders.length).toBeGreaterThanOrEqual(4);
    expect(collections[0].folders[0].tileShape).toBe('LANDSCAPE');
  });
});
