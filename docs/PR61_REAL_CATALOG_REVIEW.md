# PR61 corrections from the real provider catalog

The isolated November 1 catalog exposed concrete association and lookup defects.
This follow-up corrects those defects without changing PR59's resolver transport,
outbound guards, capacity limits or shared resolve-cache protocol.

## Original evidence

The supplied catalog has SHA256
`72021832a11b7bb6ca1f3f7dd9ac3c4a5ebb7e28e7ef24aa49d77a92d39da7a7`,
schema4, timestamp `2026-11-01T13:16:47.559Z`, 8,075 rows and 14,822 source
associations from 14 providers. Its byte size, counts and original sync summary
agree. Recorded hashes of sync-matches.js, container.js and MatchAggregator.js
match the reviewed source after LF-to-CRLF conversion; the staged checkout has
no .git. Those checks establish the inspected file contents, not an independent
hash of every staged dependency. The tested baseline was PR61 e1055fd7.

The command completed despite partial provider failures, as its documented exit
contract permits. WatchFooty failed DNS validation; DamiTV encountered local
native capacity and a later timeout; StreamedPk returned HTML to JSON parsers.
The raw stderr also records an AK47 event-feed capacity failure, although its
playlist sources contributed rows. MLB contributed rows after a page fallback.
Neither source counts nor exit0 establish every provider's health or playback.

## Corrected behavior

- Two Villanova–Notre Dame rows had the same `dlv_54_villanova-vs-notre-dame`
  ID but different explicit squad/competition metadata. The actual cache loader
  rejected that canonical identity as ambiguous, making both cards unusable.
  DaddyLive fixture IDs now derive from event title, category, kickoff, league
  and participant metadata, independently of the first broadcast channel. Old
  channel/title fixture IDs remain aliases when unique; ambiguous old links
  still return no match. A missing new strong fixture key cannot fall through
  to a different source or fuzzy title.
- The catalog retained WNBA/NBA Finals sources explicitly naming different game
  numbers inside one merged row, and repeated LiveTV fixtures from different
  dates. The old four-day replay window, early team-match shortcut and moving
  comparison date could combine consecutive meetings. Replay matching now
  retains bounded, validated date/game constraints from accepted rows, including
  across JSON cache reuse. Different numbered games or precise rematches stay
  separate. Calendar-only dates can still match a compatible UTC kickoff across
  a timezone boundary; a coarse date compatible with multiple fixtures does
  not select the first one. Missing dates remain unknown for matching even when
  a display date is supplied, including after an expired replay refresh.
- Undated SoccerFull entries therefore remain separate from a dated meeting
  until fixture evidence exists. Their original sources remain available.
  This intentionally favors separate cards over associating an unknown archive
  with an arbitrary repeated fixture. Live/motorsport date policies are retained.
- DaddyLive's title `Tyson Fury vs Anthony Joshua Fight live on Friday,
  December 11, 2026` had inherited the November1 schedule date. Both supported
  explicit date orders now take precedence; impossible explicit calendar dates
  are skipped instead of inheriting another day. This parses the provider's
  advertised date, not verification that the advertised event will occur.
- The interior Spanish word `de` no longer supplies a German country annotation
  or disappears from a channel's identity. Explicit country/countryCode metadata
  remains authoritative and distinguishes memoized identities. Broadcaster
  aliases use the existing country rule data, including RO/BG/HR. Old title-slug
  channel IDs from DaddyLive and CDN remain explicit aliases after corrected
  canonical naming, preserving the inspected saved bookmarks.
- Parameterized Opossum fallbacks now read the terminal error argument rather
  than the original URL argument. Existing error sanitization removes query
  credentials from diagnostics. AK47 event-feed and MLB endpoint failures are
  exposed through the existing schedule-health contract even when other rows
  survive; successful sources and existing refresh cadence remain unchanged.

The original catalog had 8,074 unique canonical IDs. A data-only check with the
actual baseline CacheService exercised 37,733 indexed canonical/alias/source
keys and confirmed the two unaddressable Villanova rows. Shared live-channel
source IDs are normal and are not classified as wrong-event merges by count.
Other replay-date anomalies are candidates for inspection, not a claim that
every multi-date row is wrong or that every upstream source has been corrected.

A pure helper comparison over 5,214 retained channel associations found 90
additional broadcaster matches, no lost previous matches and no changed
previous targets. This is lookup evidence: Vavoo contributed zero real sources
in this run, so it does not establish real Vavoo enrichment or playback.

## Fresh 7fe6165 catalog and metadata follow-up

The next real sync produced 9,710 rows with SHA256
`c31b33e55574fc7055bd70b2d86f14f2287190121370afa67b6b6ed8d5a36010`.
All canonical IDs are unique and resolve through the candidate cache lookup;
unique aliases and the inspected old channel bookmarks also resolve. The old
Villanova alias is intentionally ambiguous. Retained-source lineage accounts
for 1,551 of the 1,635-row increase through separation, rather than discovery
of that many new games. The observed WNBA/NBA game splits and December11
promotional date are present in the real data.

That sync exposed remaining metadata inconsistencies. Seventeen ReplayZone
calendar rows displayed upstream dates that disagreed with their explicit title
dates and already chosen identity claims. Fresh calendar replay rows now use
that same validated title day for persistence, sorting and retention. Precise
UTC kickoffs and existing cached claim/date anchors remain unchanged. This
aligns metadata with the chosen identity evidence; it does not independently
verify that the upstream title describes the video correctly.

Bounded textual parsing also accepts the observed `8, May 2026` and abbreviated
`Oct` forms. Invalid calendars and ambiguous numeric dates remain unknown. Old
2023/2024 rows whose historical date becomes known can expire under existing
retention; this patch does not change retention windows. Standalone MLB/Hockey
still use the existing24-hour active filter rather than the longer source list.

Six rows explicitly labelled Handball Bundesliga were displayed as football.
They now use the supported `other` category, retaining a separate explicit-sport
guard against same-club football/unknown fixtures. Continuous channels are
unaffected. An observed `Canada. CFL` generic row uses `american_football`;
an unqualified CFL token does not infer a sport.

The 2,854 entries without dates comprise 2,824 continuous channels and30
undated AK47 listings. They are not2,854 broken fixture dates. Leaf and Vavoo
were not configured in this run. In particular, a reversed team order between
an opaque TimStreams ID and its display title does not establish a Leaf error:
the inspected canonical/alias lookups succeed and Leaf uses its own source ID.

The actual new stderr shows MLB's fallback reason as native capacity, confirming
the diagnostic correction despite the forwarded prose still saying undefined.
FullRaces also reports a partial category fetch failure. Degradation remains
visible; neither these logs nor more AK47 associations establish playback.

## Verification and review

The new failures were reproduced before their fixes using real-catalog-derived
metadata and simulated provider I/O. Five regression suites cover fixture IDs,
explicit dates, replay identity/cache transitions, country/signal identity,
partial provider health and the real Opossum fallback contract.

Both Node22.23.2 and Node24.19.0 pass the complete selected offline command:

```sh
node scripts/test-pr61-offline.cjs
```

Results: inherited64 suites/636 passing tests plus PR61's57 suites/476 passing
tests = **121 suites/1,112 passing Jest tests**, seven additional Node tests and
one existing TODO. The boundary blocks sockets/listeners and actual workers.
This is not a full repository green-suite claim.

`npm run build` passes on Node22 with npm offline mode using cached ncc0.45.0
and copyfiles2.4.1. No dependency or workflow declaration changed. Nineteen
copied runtime files were checked and17 static imports resolved without loading
the runtime; this does not execute native/WASM providers. Two independent
review passes identified and closed the old-channel bookmark regression and
expired replay date-recovery bug. The latter also has a data-flow mutation
check: reverting only its guard combines two rows; the fix preserves both.

## Required fresh verification and release limits

Already merged rows cannot be reconstructed from their final title/date alone.
Use a **new isolated cache path** and one real sync on the new candidate before
assessing these corrections. Do not reuse the old merged8075-row file as proof
of repaired ingestion, and do not require the new row count to stay8075 when
previously combined events are correctly separated. Do not delete production
data as part of the experiment.

The earlier actual-addon cache/TLS/lifecycle/rotation evidence remains scoped
evidence for unchanged infrastructure components. This follow-up does not claim
a newly deployed bundle, actual advertised video playback, upstream403/404
repair, device/DRM support, WARP behavior, arm64 execution or sustained load.
Those original provider/player checks remain separate acceptance work. No
transport/capacity limit was relaxed to turn a source failure into a green row.

Keep PR61 draft while new-candidate results are reviewed. PR59 is unchanged and
remains the dependency; integrate it first and check PR61 against updated stable.
