'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const expected = [
  ['2026-11-01', 'November 1, 2026', 'Nov 1, 2026', 'NOV'],
  ['2027-01-01', 'January 1, 2027', 'Jan 1, 2027', 'JAN'],
  ['2026-03-01', 'March 1, 2026', 'Mar 1, 2026', 'MAR']
];

describe.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('calendar presentation on a %s host', hostZone => {
  let result;
  beforeAll(() => {
    result = JSON.parse(execFileSync(process.execPath, [
      '--require', path.join(__dirname, 'fixtures/pr59-offline-boundary.cjs'),
      path.join(__dirname, 'fixtures/timezone-calendar-probe.cjs')
    ], { env: { ...process.env, TZ: hostZone }, encoding: 'utf8', timeout: 10000 }));
  });

  test('the probe uses the requested host timezone', () => {
    expect(result.hostZone).toBe(hostZone);
  });

  test.each(expected)('%s retains its UTC bucket labels and release date', (day, longDate, shortDate, month) => {
    const row = result.cases.find(item => item.day === day);
    expect(row.releaseInfo).toBe(longDate);
    expect(row.seasonName).toBe(longDate);
    expect(row.description).toContain(`Season 1: ${shortDate} (1 matches)`);
    expect(row.cardReleaseInfo).toBe(longDate);
    expect(row.released).toBe(`${day}T00:00:00.000Z`);
    expect(row.posterDates.length).toBeGreaterThan(0);
    expect(row.posterDates.every(date => date === longDate)).toBe(true);
    expect(row.svgLabels.slice(0, 3)).toEqual([month, '1', day]);
  });
});
