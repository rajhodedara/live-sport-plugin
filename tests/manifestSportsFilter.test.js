'use strict';

const { manifest, filterCatalogsBySports } = require('../src/manifest');

describe('filterCatalogsBySports (issue #65)', () => {
  test('includes nuvio_sports_college when college is in the configured sports list', () => {
    const filtered = filterCatalogsBySports(manifest.catalogs, 'football,college');
    const ids = filtered.map(c => c.id);

    expect(ids).toContain('nuvio_sports_football');
    expect(ids).toContain('nuvio_sports_college');
    expect(ids).toContain('nuvio_sports_live');
    expect(ids).toContain('nuvio_sports_upcoming');
    expect(ids).toContain('nuvio_sports_networks');
    expect(ids).toContain('nuvio_sports_replays');
    expect(ids).toContain('nuvio_sports_replays_football');
    expect(ids).not.toContain('nuvio_sports_basketball');
    expect(ids).not.toContain('nuvio_sports_other');
  });

  test('keeps every sport catalog defined in manifest when explicitly listed', () => {
    const allSportIds = manifest.catalogs
      .map(c => c.id)
      .filter(id => id.startsWith('nuvio_sports_') && !id.startsWith('nuvio_sports_replays_'))
      .map(id => id.slice('nuvio_sports_'.length))
      .filter(name => !['teams', 'live', 'upcoming', 'networks', 'replays'].includes(name));

    const filtered = filterCatalogsBySports(manifest.catalogs, allSportIds.join(','));
    expect(filtered.map(c => c.id)).toEqual(manifest.catalogs.map(c => c.id));
  });

  test('returns all catalogs unchanged when sports is "all" or unset', () => {
    expect(filterCatalogsBySports(manifest.catalogs, 'all')).toBe(manifest.catalogs);
    expect(filterCatalogsBySports(manifest.catalogs, undefined)).toBe(manifest.catalogs);
  });
});
