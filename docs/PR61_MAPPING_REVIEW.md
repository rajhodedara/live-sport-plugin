# PR61 source and event mapping correction

This local follow-up builds on the integrated PR61 candidate 7d72771 and its
PR59 dependency f240afd. It addresses reproducible association mistakes. It is
not evidence that the Discord playback photos were caused by these defects.

## Resulting behavior

- Broadcaster lookup preserves explicit source country/group/countryCode and
  country annotations in the name. `Sky Sport F1 IT`, `DAZN 1 DE` and
  `beIN Sports 1 FR` select Italy, Germany and France respectively. An absent
  requested region or conflicting metadata produces no injected alternative
  from another country. Unqualified names retain existing catalog priorities.
- Lookup accepts known names, known aliases and quality/backup annotations.
  Arbitrary suffixes do not turn an unknown signal into another feed; for
  example `TNT Sports 1 2` does not become channel1. Intrinsic brand words
  remain intact: Spanish `de`, `ITV BE`, `BE SPORTS` and `BEINSPORT AR 1` are
  not blindly consumed as country tags. Prefix/suffix annotations and Unicode
  catalog names are covered.
- Match identity keeps explicit gender, age and reserve distinctions. A
  qualified fixture and an unqualified one stay separate rather than assuming
  that the unqualified record is the same squad. This can create duplicate
  cards when a provider omits these details. Recognized aliases, reversed team
  order, dash separators, `(W)`/`(B)` and mixed reserve-level fixtures remain
  supported. Participant qualifiers stay attached to their competitor; only
  event-wide metadata may be inherited by both sides.
- Exact IDs respect existing date/session guards and explicit team/squad
  contradictions. The date thresholds are unchanged. TBA placeholders can
  acquire their real teams under the same ID without being treated as a
  contradictory matchup. Source deduplication preserves country context, and
  broadcaster enrichment forwards it instead of retaining only a channel name.
- Catalog-cache lookup rejects ambiguous canonical IDs, aliases and source IDs
  instead of selecting the first/last event. A unique canonical ID takes
  precedence over weaker aliases. Legacy source fragments require token
  boundaries and a unique event; a URL parameter is not treated as a partial
  source identity. Normalized legacy fixture slugs also require a unique match.
  Canonical, unique alias/source and unique legacy slug lookup remain supported.

## Evidence and review

New regressions failed before their corresponding fixes, including the three
reported regional examples, partial numeric source IDs, ambiguous fixture slugs,
unlabelled/youth/reserve association, and reused IDs with contradictory teams.
Review caught and corrected compatibility regressions involving Spanish channel
names, decorated brands, participant-scoped qualifiers, mixed B/C fixtures,
dash separators and placeholders. Two independent reviews closed their findings.

The mapping scenario suite exercises actual aggregation, disk-backed catalog
cache, source selection/dispatch and final stream publication. Provider catalog
and media responses are synthetic; no real upstream or player is used. The
committed-catalog test checks all 8,147 complete rows with their supplied group.
It verifies regional identity, not whether those channels currently play.

Run the combined provider/mapping and inherited PR59 selection with:

```sh
node scripts/test-pr61-offline.cjs
npm run build
```

The existing preload blocks worker creation, socket connects and listeners.
The exact selected tests remain listed in the scripts. This is not a full Jest
suite or production playback claim. See PR61_INTEGRATION_REVIEW.md for totals.

## Acceptance and compatibility limits

Conservative matching may omit an injected Vavoo alternative, leave separate
cards or reject an ambiguous old saved link. Existing original provider sources
remain available when only broadcaster enrichment cannot establish a match.
Duplicate canonical IDs must be corrected by their provider; they are not
silently assigned to one of the events.

These changes cannot reconstruct which sources belonged to an already-mixed
persisted row. Validate with a fresh isolated catalog sync before evaluating
the mapping result; no production cache was deleted and the schema was not
changed. Missing or inaccurate provider dates/labels still limit matching;
repeated meetings inside existing time windows are not automatically identified
as separate games. Known-language labels/aliases are not a complete worldwide
team or league database.

A valid URL or HTTP200 still does not prove that the video shows the advertised
match. Broadcaster program schedules, real playback, DRM/client support and
upstream403/404 are separate acceptance checks. No production process or PR head
is changed by this local review.
