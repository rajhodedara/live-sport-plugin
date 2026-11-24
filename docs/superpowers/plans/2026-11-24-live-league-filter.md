# Live League Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Nuvio users choose which competitions can appear among currently live fixtures through the Configure page.

**Architecture:** Share one curated competition registry between the browser picker and the server matcher. Persist selections in the existing encoded add-on URL and apply them in the catalog before sorting and pagination.

**Tech Stack:** Node/CommonJS, Express, Stremio Addon SDK, vanilla HTML/CSS/JavaScript, Jest, and the existing Configure DOM verification script.

**Spec:** The “Short design: live-league filtering” in this chat and the two reference screenshots. The user's live-only instruction governs scope. This plan interprets it as currently live fixtures, including live entries in mixed rows. Upcoming fixtures, replays, and 24/7 channels retain their existing behavior.

## Global Constraints

- Strict allowlist when customized. Sports and league selections both apply to live fixtures.
- All curated options and “Other competitions” start checked. Existing add-on links and untouched settings show all fixtures.
- A customized empty selection hides all currently live fixtures and shows a warning in the Configure flow.
- Save selections per add-on URL. Use the existing config decoding and install-link flow.
- Preserve replay exports, manifest rows, direct meta/playback behavior, provider ingestion, and the existing page theme. Add no dependencies.

## Review Focus

- Similar names and acronyms resolve distinctly, including Premier League versus Tanzanian Premier League, La Liga versus LaLiga 2, and NBA versus WNBA (Task 1).
- A missing league can only be inferred from an explicit, unambiguous competition label in the title (Task 1).
- A future kickoff carrying a provider's live flag remains outside the filter (Task 2).
- Two users requesting the same catalog page receive their own selections even with separator-like characters in custom names (Task 2).
- Checked options and custom names survive a return to the Configure URL, including an empty selection and names containing punctuation (Task 3).

## File map

| Path | Responsibility |
| --- | --- |
| `public/live-league-options.js` | Shared option records, labels, sports and aliases. Served as a local script and bundled through a static CommonJS import. |
| `src/services/LiveLeagueFilter.js` | Config validation and classification of a single fixture. |
| `src/catalog.js` | Catalog scope, filter ordering and page-cache keys. |
| `public/configure.html` | Sports-panel picker, restore/save behavior and install summary. |
| `tests/liveLeagueFilter.test.js`, `tests/liveLeagueCatalog.test.js` | Matcher and catalog behavior. |
| `tests/configurePageWiring.test.js`, `scripts/verify-configure-wiring.js` | Markup and DOM-driven install-link verification. |

---

### Task 1 — Define competition options and match fixtures

**Files:** Create `public/live-league-options.js`, `src/services/LiveLeagueFilter.js`, and `tests/liveLeagueFilter.test.js`.

**Interfaces:** Export `LIVE_LEAGUE_GROUPS` as ordered group records `{ label, options }` whose options contain `id`, `label`, `categories`, and `aliases`. Expose the same data to the browser as `window.LIVE_LEAGUE_GROUPS`. Export `parseLiveLeagues(value)` and `matchesLiveLeague(fixture, selection)` from the server service. The parser returns `null` for omitted or structurally invalid config and a sanitized `{ ids: string[], custom: string[], other: boolean }` for valid config. The matcher accepts a fixture with `category`, `league`, and `title`, and returns a boolean. The catalog owns the decision to call it.

- [ ] Add tests using these fixtures and assertions. Use `parseLiveLeagues` when creating the selections.

  | Fixture or config | Selection | Expected |
  | --- | --- | --- |
  | Football, `English Premier League` | `epl` | included |
  | Football, `Tanzanian Premier League` | `epl` | excluded |
  | Football, `LaLiga 2` | `la-liga` | excluded |
  | Basketball, `WNBA` | `nba` | excluded |
  | Basketball, `NBA Playoffs` | `nba` | included |
  | Football, missing league, `UEFA Champions League: Arsenal vs Inter` | `ucl` | included |
  | Football, missing league, `Arsenal vs Inter` | `ucl` | excluded |
  | Football, `UEFA Europa League`, title containing `UEFA Champions League:` | `ucl` | excluded |
  | Football, `Copa do Brasil` | custom `  COPA do Brasil  ` | included |
  | Football, `Copa do Brasil U20` | custom `Copa do Brasil` | excluded |
  | Basketball, `NBA` | Other only | excluded |
  | Football, unknown league or no competition label | Other only | included |
  | Selection omitted, structurally invalid, or explicitly empty | any fixture | omitted/invalid includes, explicit empty excludes |

- [ ] Run `npm test -- --runInBand tests/liveLeagueFilter.test.js`. Expect the new tests to fail because the service is missing.
- [ ] Create the registry using this inventory. Use stable lowercase kebab-case IDs and pin `epl`, `la-liga`, `nba`, and `ucl` to their named competitions.

  | Group | Curated options |
  | --- | --- |
  | Soccer | MLS, NWSL, Tanzanian Premier League, Premier League, LaLiga 2, La Liga, Serie A, 2. Bundesliga, Bundesliga, Ligue 1, CAF Champions League, Women's Champions League, Champions League, Europa League, Liga MX, Brasileirão, Argentine Primera, Saudi Pro League |
  | American Football | NFL, College Football, UFL, CFL |
  | Basketball | NBA, WNBA, College Basketball, EuroLeague, NBL |
  | Baseball | MLB, College Baseball |
  | Hockey | NHL, College Hockey |
  | Tennis | ATP, WTA, Grand Slams |
  | Cricket | IPL, T20 World Cup, Big Bash, PSL |
  | Motorsport | Formula 1, MotoGP, NASCAR, IndyCar |
  | Rugby | Six Nations, Super Rugby, NRL |
  | Combat Sports | UFC, Boxing, PFL |
  | Golf | PGA Tour, LIV Golf |
  | Darts | PDC Darts |

- [ ] Add exact aliases verified against existing provider fixtures or source strings. Include `EPL` and `English Premier League` for Premier League, `UEFA Champions League` for Champions League, and `NBA Playoffs` and `NBA Finals` for NBA. Give each option its repository category, using `football` for soccer and `mma` for combat sports. For college options, require a sport-specific alias if the fixture has the generic `college` category. Keep “Other competitions” a separate switch.
- [ ] Export `normalizeLeagueName(value: string): string` beside the shared registry for the parser, matcher and picker. Fold case and accents, replace punctuation runs with spaces, collapse whitespace and trim. Implement the parser with unique known IDs, at most 12 custom names of 60 characters each, and deduplication by the normalized key while retaining each trimmed display name. Use structural validation before sanitizing values so a malformed object and a deliberate empty list remain distinguishable. Reject custom names that normalize to empty or duplicate a curated label or alias and route users to the curated option in the UI.
- [ ] Implement the matcher. Prefer an exact sport-scoped curated match on the provider league field, then an exact custom match. Consult the title only for a missing league or a field that normalizes to the sport name. Use an exact competition label before a colon or after the final spaced dash. If there is no recognized label, the fixture falls into Other. A known but unchecked curated competition stays excluded even with Other selected. Custom names that are unchecked or removed have no dedicated category and can still appear through Other. Apply no user-defined regex or substring matching.
- [ ] Rerun the Task 1 command. Expect all assertions to pass.
- [ ] Commit the registry, matcher and matcher tests as `feat: define live league matching`.

### Task 2 — Apply the filter to live catalog entries

**Files:** Modify `src/catalog.js` in `handleCatalog` and `handleCatalogUncached`. Create `tests/liveLeagueCatalog.test.js`.

**Interfaces:** Read `conf.liveLeagues` using the Task 1 parser and matcher. Keep the public `handleCatalog(type, id, extra, config)` signature.

- [ ] Write a catalog test using a stubbed CacheService, a fixed clock and real `handleCatalog`. Seed `live-epl`, `live-ucl`, `future-ucl` with provider status `live`, `replay-ucl` and `channel`. Assert IDs through the real catalog response:

  | Request | Expected match IDs |
  | --- | --- |
  | Live row, EPL only | `live-epl` and `channel` |
  | Same Live row, UCL only, same cache revision | `live-ucl` and `channel` |
  | Mixed row, EPL only | `live-epl`, `future-ucl`, and `channel` |
  | Upcoming row, EPL only | `future-ucl` |
  | Same Live row, explicit empty | `channel` |
  | Same Live row, config omitted | `live-epl`, `live-ucl`, and `channel` |
  | Replay competition row, explicit empty | `replay-ucl`, identical to the unconfigured response |

- [ ] Add regression cases that find the same excluded live fixture through its sport row, Your Teams and search. Add a search/pagination case in which filtered-out live fixtures precede the first eligible result. Add a cache test with two custom-name arrays containing `&`, `=` or `|` and assert each produces its own result.
- [ ] Run `npm test -- --runInBand tests/liveLeagueCatalog.test.js`. Expect the strict-filter assertions to fail.
- [ ] In `handleCatalogUncached`, preserve existing sports and replay checks, then filter currently live non-channel fixtures before sort, search and pagination. Use `isMatchLive` and exempt both `category === 'networks'` and `isChannel`. Keep the existing replay catalog early return and guard the mixed catalog with its existing `isReplayMode`.
- [ ] Use a structured, escaped page-cache key in `handleCatalog`, with sorted object keys, ordered array values, and route, extra, full config and generation as separate components. Replace the delimiter-based `_stableSig` for this key. Keep the existing cache revision and TTL behavior. Leave the separate meta cache alone.
- [ ] Rerun the Task 2 suite together with `tests/liveLeagueFilter.test.js`, `tests/replayClassification.test.js` and `tests/replayHubs.test.js`. Expect all suites to pass.
- [ ] Commit the catalog and tests as `feat: filter currently live catalog fixtures by league`.

### Task 3 — Add the Configure picker and verify the install flow

**Files:** Modify `public/configure.html`, `tests/configurePageWiring.test.js`, and `scripts/verify-configure-wiring.js`.

**Interfaces:** Read `window.LIVE_LEAGUE_GROUPS` and `window.normalizeLeagueName` from the shared script. Repopulate from `existingConfig.liveLeagues`. Serialize the Task 1 object via `updateLink()` when customized, including an explicit empty selection. A default picker omits the setting. Keep league preferences out of replay Collections URLs and parameters while preserving their existing settings.

- [ ] Extend the markup test to check that the picker lives in `#sec-sports`, loads `/live-league-options.js` before the Configure script, and labels its search, custom input and count. Extend the existing DOM verifier to load the shared script and check these interactions on the served page:

  | Interaction | Expected |
  | --- | --- |
  | Open `/configure` | All curated checkboxes and Other checked, summary says “All”, decoded manifest config has no `liveLeagues` |
  | Search for `bundesliga` | Both Bundesliga options visible; hidden choices retain their state |
  | Clear, then check Premier League | Decoded install config has `{ ids: ['epl'], custom: [], other: false }` |
  | Add `Copa do Brasil` and `Copa d’Été, Série A`, reopen the encoded Configure URL | Both names and Premier League restored, preserving punctuation; summary shows “3 selected” |
  | Add the same custom name again with different casing, or add `EPL` | No duplicate; the latter points to Premier League |
  | Clear all | Decoded config has `{ ids: [], custom: [], other: false }` and a live-catalog warning appears in review |
  | Select all after Clear | Default restored and `liveLeagues` omitted |
  | Customize live leagues | Collections links still carry existing replay settings and omit `liveLeagues` |

- [ ] Run `npm test -- --runInBand tests/configurePageWiring.test.js`. Expect the new markup assertions to fail. Run the DOM verifier against a local instance with a Node version supported by the repo and confirm the new interaction assertions fail before implementation.
- [ ] Add an optional “Live leagues” disclosure beneath the Sports chips, visible in both dashboard and wizard modes. Show the selection summary in its header. In its expanded state, place “Find a league” and the “Select all” / “Clear” actions above sport-grouped checkbox chips, followed by “Other competitions” and the “Add a custom league” field with an “Add” button. Select all restores every curated option and Other. Clear clears curated options, Other and custom chips. Label global controls and keep them global during a search. Show removable custom chips, and keep selections from unchecked sports for when those sports are enabled again.
- [ ] Reuse the page's Outfit headings and system body type, existing surface/accent/focus tokens in both themes, and responsive chip grid. Align group labels and controls to the left. Use native checkbox state and a visible checkmark for selection, retain visible keyboard focus, allow long names to wrap, and use one column on narrow screens. Render text from the user with DOM text nodes. Search applies to labels and aliases; announce selection changes and validation via a polite live region. Use the existing app's red accent and neutral surfaces for the competition chips.
- [ ] Wire checkbox changes, custom additions/removals, Select all and Clear to the existing link refresh. Bind Enter in the custom field and show duplicate, invalid-length and limit feedback. Show “All”, “N selected”, or “None” in review. For an empty allowlist show “No live fixtures will appear. Select a league to show live fixtures.” Keep installation available with valid remaining settings.
- [ ] Run `npm test -- --runInBand tests/configurePageWiring.test.js tests/configureTimezoneSelection.test.js tests/liveLeagueFilter.test.js tests/liveLeagueCatalog.test.js tests/replayHubs.test.js tests/replayCollectionsFix.test.js`. Run `node scripts/verify-configure-wiring.js` with the local app serving port 7000. Expect passing exit codes and the decoded link assertions to pass. Check keyboard navigation, long labels, and layout at 320 px and desktop widths in both themes and both Configure modes.
- [ ] Verify that `npm run build` includes the shared option script and that the built app serves it. On the built app, request a live catalog using the config segment produced by Configure, then confirm filtered IDs and unchanged upcoming and replay results using a deterministic fixture cache. Confirm the manifest URL and copied URL carry the same preference.
- [ ] Commit the Configure files and verifier as `feat: add live league preferences to Configure`.
