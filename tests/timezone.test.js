'use strict';

const { parseTimezone } = require('../src/timezone');

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

describe('parseTimezone — DST correctness (regression)', () => {
  // The old implementation derived the offset by formatting the naive instant
  // itself. Inside the hour after a DST transition that yielded the wrong side
  // of the change, so every conversion there was one hour off. These assertions
  // pin the exact UTC instants against an independent resolver.
  test('spring forward: 03:30 America/New_York is EDT (UTC-4), not EST', () => {
    expect(iso(parseTimezone('2026-03-08T03:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z');
  });

  test('spring forward: 01:30 America/New_York is still EST (UTC-5)', () => {
    expect(iso(parseTimezone('2026-03-08T01:30', 'America/New_York'))).toBe('2026-03-08T06:30:00.000Z');
  });

  test('fall back: 01:30 America/New_York picks the earlier (EDT) instant', () => {
    expect(iso(parseTimezone('2026-11-01T01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
  });

  test('fall back: 03:30 America/New_York is EST (UTC-5) after the change', () => {
    expect(iso(parseTimezone('2026-11-01T03:30', 'America/New_York'))).toBe('2026-11-01T08:30:00.000Z');
  });

  test('fall back in the southern hemisphere: 00:30 Australia/Sydney', () => {
    expect(iso(parseTimezone('2026-10-04T00:30', 'Australia/Sydney'))).toBe('2026-10-03T14:30:00.000Z');
  });

  test('London fall back: 01:30 Europe/London picks the earlier (BST) instant', () => {
    expect(iso(parseTimezone('2026-10-25T01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z');
  });

  test('a full spring-forward sweep matches the transition exactly once', () => {
    const start = Date.UTC(2026, 2, 8, 7, 0); // 07:00Z == 03:00 local EDT
    expect(iso(parseTimezone('2026-03-08T03:00', 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(parseTimezone('2026-03-08T04:00', 'America/New_York'))).toBe('2026-03-08T08:00:00.000Z');
    expect(start).toBe(Date.parse('2026-03-08T07:00:00Z'));
  });
});

describe('parseTimezone — unambiguous conversions', () => {
  test('naive wall time is interpreted in the target zone', () => {
    expect(iso(parseTimezone('2026-09-20T17:00', 'America/New_York'))).toBe('2026-09-20T21:00:00.000Z');
    expect(iso(parseTimezone('2026-09-20T17:00', 'Asia/Calcutta'))).toBe('2026-09-20T11:30:00.000Z');
    expect(iso(parseTimezone('2026-09-20T17:00', 'Europe/London'))).toBe('2026-09-20T16:00:00.000Z');
    expect(iso(parseTimezone('2026-09-20T17:00', 'UTC'))).toBe('2026-09-20T17:00:00.000Z');
  });

  test('space-separated form is treated the same as the T form', () => {
    expect(parseTimezone('2026-09-20 17:00', 'America/New_York')).toBe(parseTimezone('2026-09-20T17:00', 'America/New_York'));
  });

  test('a date-only string resolves to midnight in the target zone', () => {
    expect(iso(parseTimezone('2026-09-14', 'UTC'))).toBe('2026-09-14T00:00:00.000Z');
    expect(iso(parseTimezone('2026-09-14', 'America/New_York'))).toBe('2026-09-14T04:00:00.000Z');
  });
});

describe('parseTimezone — explicit offsets are honoured verbatim', () => {
  test('Z suffix', () => {
    expect(iso(parseTimezone('2026-09-20T17:00:00Z', 'America/New_York'))).toBe('2026-09-20T17:00:00.000Z');
  });

  test('+05:30 with colon', () => {
    expect(iso(parseTimezone('2026-09-20T17:00:00+05:30', 'UTC'))).toBe('2026-09-20T11:30:00.000Z');
  });

  test('+0530 without colon', () => {
    expect(iso(parseTimezone('2026-09-20T17:00+0530', 'UTC'))).toBe('2026-09-20T11:30:00.000Z');
  });

  test('sub-millisecond precision is preserved', () => {
    expect(iso(parseTimezone('2026-09-20T17:00:00.500Z', 'UTC'))).toBe('2026-09-20T17:00:00.500Z');
  });
});

describe('parseTimezone — numeric input', () => {
  test('epoch seconds are widened to milliseconds', () => {
    expect(parseTimezone(1789923600, 'UTC')).toBe(1789923600000);
    expect(parseTimezone('1789923600', 'UTC')).toBe(1789923600000);
  });

  test('epoch milliseconds pass through', () => {
    expect(parseTimezone(1789923600000, 'UTC')).toBe(1789923600000);
    expect(parseTimezone('1789923600000', 'UTC')).toBe(1789923600000);
  });
});

describe('parseTimezone — bare time-only strings', () => {
  test('HH:MM resolves against the target zone', () => {
    const r = parseTimezone('17:00', 'UTC');
    expect(r).not.toBeNull();
    // Only the clock portion is meaningful; the date is "today" in the target zone.
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(r));
    expect(p).toBe('17:00');
  });

  test('single-digit hour is padded correctly', () => {
    const r = parseTimezone('9:30', 'UTC');
    expect(r).not.toBeNull();
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(r));
    expect(p).toBe('09:30');
  });
});

describe('parseTimezone — invalid input returns null', () => {
  const invalid = [null, undefined, '', '   ', '0', 0, -5, '-1', 'abc', '2026-13-45T99:99', NaN, Infinity];
  test.each(invalid)('%p -> null', (v) => {
    expect(parseTimezone(v, 'UTC')).toBeNull();
  });

  test('does not throw on any of the invalid inputs', () => {
    for (const v of invalid) {
      expect(() => parseTimezone(v, 'UTC')).not.toThrow();
    }
  });
});
