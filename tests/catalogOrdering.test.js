'use strict';

const { manifest, buildManifestCatalogs } = require('../src/manifest');
const { generateCollections } = require('../src/collections');

const seg = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('Catalog Ordering and Customization', () => {
  describe('buildManifestCatalogs', () => {
    test('preserves default catalog order when sports is default or all', () => {
      const catalogs = buildManifestCatalogs(manifest.catalogs, {});
      const ids = catalogs.map(c => c.id);

      expect(ids).toContain('nuvio_sports_live');
      expect(ids).toContain('nuvio_sports_networks');
      expect(ids).toContain('nuvio_sports_replays');
      expect(ids).toContain('nuvio_sports_football');
      expect(ids).toContain('nuvio_sports_basketball');
      expect(ids).toContain('nuvio_sports_upcoming');

      const footballIdx = ids.indexOf('nuvio_sports_football');
      const cricketIdx = ids.indexOf('nuvio_sports_cricket');
      const basketballIdx = ids.indexOf('nuvio_sports_basketball');

      expect(footballIdx).toBeLessThan(cricketIdx);
      expect(cricketIdx).toBeLessThan(basketballIdx);
    });

    test('reorders sport catalogs according to user custom sequence', () => {
      const config = { sports: 'basketball,cricket,football' };
      const catalogs = buildManifestCatalogs(manifest.catalogs, config);
      const ids = catalogs.map(c => c.id);

      const bballIdx = ids.indexOf('nuvio_sports_basketball');
      const cricketIdx = ids.indexOf('nuvio_sports_cricket');
      const footballIdx = ids.indexOf('nuvio_sports_football');

      expect(bballIdx).toBeGreaterThanOrEqual(0);
      expect(cricketIdx).toBeGreaterThanOrEqual(0);
      expect(footballIdx).toBeGreaterThanOrEqual(0);

      // Verify exact user order
      expect(bballIdx).toBeLessThan(cricketIdx);
      expect(cricketIdx).toBeLessThan(footballIdx);

      // Excluded sports must not be in the manifest
      expect(ids).not.toContain('nuvio_sports_motorsport');
      expect(ids).not.toContain('nuvio_sports_hockey');
      expect(ids).not.toContain('nuvio_sports_tennis');

      // Top anchors and upcoming remain intact
      expect(ids).toContain('nuvio_sports_live');
      expect(ids).toContain('nuvio_sports_networks');
      expect(ids[ids.length - 1]).toBe('nuvio_sports_upcoming');
    });

    test('reorders replay sub-catalogs matching user sports order', () => {
      const config = { sports: 'basketball,football' };
      const catalogs = buildManifestCatalogs(manifest.catalogs, config);
      const ids = catalogs.map(c => c.id);

      const bballReplayIdx = ids.indexOf('nuvio_sports_replays_basketball');
      const fbReplayIdx = ids.indexOf('nuvio_sports_replays_football');

      expect(bballReplayIdx).toBeGreaterThanOrEqual(0);
      expect(fbReplayIdx).toBeGreaterThanOrEqual(0);
      expect(bballReplayIdx).toBeLessThan(fbReplayIdx);

      // Excluded replay sub-catalogs must not be present
      expect(ids.some(id => id.startsWith('nuvio_sports_replays_motorsport'))).toBe(false);
      expect(ids.some(id => id.startsWith('nuvio_sports_replays_baseball'))).toBe(false);
    });

    test('handles sports: "none" by excluding all sport catalogs', () => {
      const config = { sports: 'none' };
      const catalogs = buildManifestCatalogs(manifest.catalogs, config);
      const ids = catalogs.map(c => c.id);

      expect(ids).not.toContain('nuvio_sports_football');
      expect(ids).not.toContain('nuvio_sports_basketball');
      expect(ids.some(id => id.startsWith('nuvio_sports_replays_football'))).toBe(false);

      // Anchor catalogs remain
      expect(ids).toContain('nuvio_sports_live');
      expect(ids).toContain('nuvio_sports_networks');
      expect(ids).toContain('nuvio_sports_upcoming');
    });

    test('reorders another custom permutation cleanly', () => {
      const config = { sports: 'tennis,motorsport,american_football' };
      const catalogs = buildManifestCatalogs(manifest.catalogs, config);
      const ids = catalogs.map(c => c.id);

      const tennisIdx = ids.indexOf('nuvio_sports_tennis');
      const motorIdx = ids.indexOf('nuvio_sports_motorsport');
      const nflIdx = ids.indexOf('nuvio_sports_american_football');

      expect(tennisIdx).toBeLessThan(motorIdx);
      expect(motorIdx).toBeLessThan(nflIdx);
    });
  });

  describe('generateCollections with custom sports order', () => {
    test('filters and orders replay folders according to config.sports', () => {
      const configSegment = seg({ sports: 'motorsport,basketball,football' });
      const cols = generateCollections('https://nuviosports.xyz', configSegment);

      expect(cols.length).toBe(1);
      const folders = cols[0].folders;
      expect(folders.length).toBe(3);
      expect(folders[0].id).toBe('folder-motorsport-replays');
      expect(folders[1].id).toBe('folder-basketball-replays');
      expect(folders[2].id).toBe('folder-football-replays');
    });

    test('returns empty folders when sports is none', () => {
      const configSegment = seg({ sports: 'none' });
      const cols = generateCollections('https://nuviosports.xyz', configSegment);

      expect(cols.length).toBe(1);
      expect(cols[0].folders.length).toBe(0);
    });

    test('returns all 8 default folders when sports is omitted or all', () => {
      const cols = generateCollections('https://nuviosports.xyz', '');
      expect(cols[0].folders.length).toBe(8);
      expect(cols[0].folders[0].id).toBe('folder-football-replays');
    });
  });
});
