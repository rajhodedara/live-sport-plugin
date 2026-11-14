const { findDroppedLiveFixtures, formatDropLine } = require('../src/services/LiveDropReport');

const NOW = Date.parse('2026-11-13T20:00:00Z');
const parseDate = (raw) => Number(raw) || 0;
const ago = (h) => String(NOW - h * 3600000);
const row = (id, hoursAgo, extra = {}) => ({
  id, category: 'cricket', date: ago(hoursAgo),
  sources: [{ source: 'daddylive' }], ...extra,
});
const run = (prev, fresh, o = {}) => findDroppedLiveFixtures(prev, fresh, { now: NOW, parseDate, ...o });

describe('findDroppedLiveFixtures', () => {
  test('reports a live fixture that is absent from the fresh sync', () => {
    const r = run([row('a', 5.5)], [{ id: 'z', sources: [{ source: 'daddylive' }] }]);
    expect(r.total).toBe(1);
    expect(r.rows[0].minutesSinceKickoff).toBe(330);
    expect(r.rows[0].providers).toContain('daddylive');
    expect(r.rows[0].providersAnswered).toContain('daddylive');
  });
  test('does not report a fixture still present, by id or alias', () => {
    expect(run([row('a', 2)], [row('a', 2)]).total).toBe(0);
    expect(run([row('a', 2)], [{ id: 'b', aliasIds: ['a'], sources: [] }]).total).toBe(0);
  });
  test('ignores upcoming, long-finished, replay and sourceless rows', () => {
    const prev = [row('up', -1), row('old', 15), row('rp', 2, { isReplay: true }), row('ns', 2, { sources: [] })];
    expect(run(prev, []).total).toBe(0);
  });
  test('marks providers that did not answer', () => {
    const r = run([row('a', 3)], [{ id: 'q', sources: [{ source: 'leaf' }] }]);
    expect(r.rows[0].providersAnswered.length).toBe(0);
  });
  test('sorts oldest first and caps the rows but keeps the total', () => {
    const prev = [row('a', 1), row('b', 9), row('c', 5)];
    const r = run(prev, [], { maxRows: 2 });
    expect(r.total).toBe(3);
    expect(r.rows.length).toBe(2);
    expect(r.rows[0].id).toBe('b');
  });
  test('tolerates empty or null input', () => {
    expect(run(null, null).total).toBe(0);
    expect(run([null, undefined], []).total).toBe(0);
  });
});

describe('formatDropLine', () => {
  test('is one sanitised line', () => {
    const line = formatDropLine({ id: 'x y\nz', category: 'cricket', minutesSinceKickoff: 300, providers: ['daddylive'], providersAnswered: [] });
    expect(line).not.toContain('\n');
    expect(line).toContain('answered=none');
    expect(line).toContain('min_since_kickoff=300');
  });

  test('appends a bounded one-line title and keeps the earlier fields first', () => {
    const base = { id: 'x', category: 'tennis', minutesSinceKickoff: 243, providers: ['daddylive'], providersAnswered: ['daddylive'] };
    const line = formatDropLine({ ...base, title: 'Player A vs Player B - ATP\nParis "Masters" ' + 'x'.repeat(100) });
    expect(line).not.toContain('\n');
    expect(line.indexOf('answered=daddylive') < line.indexOf('title="')).toBe(true);
    expect(line.slice(line.indexOf('title="') + 7, -1).length <= 60).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    expect(line.slice(line.indexOf('title="') + 7, -1)).not.toContain('"');
  });
  test('omits the title field when there is none', () => {
    const line = formatDropLine({ id: 'x', category: 'tennis', minutesSinceKickoff: 1, providers: ['a'], providersAnswered: [], title: '' });
    expect(line).not.toContain('title=');
  });
  test('findDroppedLiveFixtures carries the title through', () => {
    const r = run([row('a', 2, { title: 'Team A vs Team B' })], []);
    expect(r.rows[0].title).toBe('Team A vs Team B');
  });
});
