'use strict';

// Regression guard: the Nuvio Collections JSON must carry the replay
// personalization WITHOUT inflating the document.
//
// History worth remembering:
//  - Every collection row queries its own manifestUrl, so that URL must carry
//    the user's replay scope or an imported collection ignores it.
//  - The first attempt embedded a second full base64 config segment in all 48
//    rows. That grew the export to ~20.5 kB and Nuvio's paste import truncated
//    it (a mid-document EOF parse error, not a syntax error).
//  - Scope now travels as two short query params (rf/lg) so it costs a few
//    bytes per row instead of ~41.

const { generateCollections } = require('../src/collections');

const seg = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const firstUrl = (cols) => cols[0].folders[0].catalogSources[0].manifestUrl;

describe('collections JSON carries the replay scope', () => {
  test('no config and no options leaves the bare manifestUrl', () => {
    expect(firstUrl(generateCollections('https://nuviosports.xyz', ''))).toBe('https://nuviosports.xyz/manifest.json');
  });

  test('replayFilter is carried as a short param', () => {
    const url = firstUrl(generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' }));
    expect(url).toMatch(/[?&]rf=mainstream/);
  });

  test('languages is carried as a short param', () => {
    const url = firstUrl(generateCollections('https://nuviosports.xyz', '', { languages: 'Spanish' }));
    expect(url).toMatch(/[?&]lg=Spanish/);
  });

  test('a config segment in the request is reused in the path, never duplicated', () => {
    const s = seg({ timezone: 'Asia/Calcutta' });
    const url = firstUrl(generateCollections('https://nuviosports.xyz', s, { replayFilter: 'mainstream' }));
    expect(url).toContain(`/${s}/manifest.json`);
    expect((url.match(new RegExp(s, 'g')) || []).length).toBe(1);
  });

  test('the document stays under the size that previously imported successfully', () => {
    const s = seg({ timezone: 'Asia/Calcutta' });
    const cols = generateCollections('https://nuviosports.xyz', s, { replayFilter: 'mainstream' });
    // 18,650 chars is the known-good pre-feature export size.
    expect(JSON.stringify(cols).length).toBeLessThan(18650);
  });

  test('every row of a folder shares one manifestUrl', () => {
    const cols = generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' });
    const srcs = cols[0].folders[0].catalogSources;
    expect(srcs.length).toBeGreaterThan(1);
    expect(new Set(srcs.map((s) => s.manifestUrl)).size).toBe(1);
  });

  test('the schema keeps a label for the UI', () => {
    const cols = generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' });
    const src = cols[0].folders[0].catalogSources[0];
    expect(typeof src.catalogName).toBe('string');
    expect(src.catalogName.length).toBeGreaterThan(0);
    expect(src.addonId).toBe('community.nuvio.live-sports');
    expect(src.type).toBe('tv');
  });

  test('collection and folder shape is unchanged', () => {
    const cols = generateCollections('https://nuviosports.xyz', '', { replayFilter: 'mainstream' });
    expect(Array.isArray(cols)).toBe(true);
    expect(cols[0].id).toBe('collection-sports-replays');
    expect(cols[0].folders.length).toBe(8);
    expect(cols[0].folders[0].tileShape).toBe('LANDSCAPE');
  });
});
