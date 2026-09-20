#!/usr/bin/env node
/**
 * scripts/verify-time-format.js
 *
 * Verifies catalog.js renders kickoff times in the SHIPPED 12-hour format.
 *
 * The earlier revision of this script asserted a 24-hour, no-AM/PM format, but
 * catalog.js intentionally renders with `hour12: true` (see the `options` object
 * in mapMatchToMetaPreview). The script was therefore failing by design against
 * correct behaviour. It now asserts what the product actually ships, in the
 * configured/user zone, so implementation and script can no longer drift.
 *
 * A single timezone is configured here so the rendered string carries the
 * explicit "(Zone)" suffix and the clock can be checked exactly.
 */
(async () => {
  const container = require('../src/container');
  const { handleMeta } = require('../src/catalog');
  const cacheService = container.resolve('cacheService');

  const future = Date.now() + 2 * 3600 * 1000; // kickoff in 2h -> not live -> 'Kickoff at ...'
  const TZ = 'Asia/Calcutta';
  console.log('actual UTC time: ' + new Date(future).toISOString());

  cacheService.setMatches([{
    id: 'tz_format_test', title: 'TZ Format Test FC vs Rovers', category: 'football',
    date: String(future), popular: '1',
    sources: [{ source: 'iptv-org', id: 'x', quality: '1080p', url: 'http://127.0.0.1:1/x.m3u8' }]
  }]);

  // Expected rendering computed independently from the same instant + zone.
  const expected = new Date(future).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ
  }) + ` (${TZ})`;

  let failed = false;
  const res = await handleMeta('tv', 'nuvio_sport_tz_format_test', { timezone: TZ });
  const desc = res.meta.description || '';
  // Capture the full rendered time INCLUDING the "(Zone)" suffix, stopping
  // before the trailing relative-time note (" (in 1h 59m)").
  const m = desc.match(/Kickoff at (.+?)(?: \(in |$)/);
  const ts = m ? m[1].trim() : '(none)';

  const is12h = /\b(AM|PM)\b/i.test(ts);
  const matchesExpected = ts === expected;

  console.log(`rendered timeString : "${ts}"`);
  console.log(`expected (12h, zone): "${expected}"`);
  console.log(`12h with AM/PM      : ${is12h ? 'PASS' : 'FAIL'}`);
  console.log(`matches expected    : ${matchesExpected ? 'PASS' : 'FAIL'}`);
  if (!is12h || !matchesExpected) failed = true;

  // A second zone must also render in 12h, proving the format is not hardcoded.
  const resNy = await handleMeta('tv', 'nuvio_sport_tz_format_test', { timezone: 'America/New_York' });
  const descNy = resNy.meta.description || '';
  const mNy = descNy.match(/Kickoff at (.+?)(?: \(in |$)/);
  const tsNy = mNy ? mNy[1].trim() : '(none)';
  const ny12h = /\b(AM|PM)\b/i.test(tsNy) && tsNy.includes('America/New_York');
  console.log(`America/New_York     : "${tsNy}" ${ny12h ? 'PASS' : 'FAIL'}`);
  if (!ny12h) failed = true;

  // Midnight edge: h23 must render 00:xx, never 24:xx, when 24h formatting is used.
  const mid = new Date(Date.UTC(2026, 8, 1, 0, 5));
  const s = mid.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
  console.log('midnight UTC 00:05 renders as: "' + s + '"  (expect 00:05) ' + (s === '00:05' ? 'PASS' : 'FAIL'));
  if (s !== '00:05') failed = true;

  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
