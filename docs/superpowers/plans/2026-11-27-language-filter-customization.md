# Live commentary language customization

> **Implementation requirement:** Read and apply the `ui-ux-pro-max` skill before designing or editing the Configure controls. Use its guidance on keyboard focus, form feedback, touch targets, and responsive layout during the browser review.

**Goal** — Let viewers prioritize or filter commentary languages for live fixtures and 24/7 channels. Replay catalogs, replay playback, and replay Collections keep their current behavior.

**Approach** — Add a **Live commentary languages** group to the existing Configure page. Store the new selection under `liveLanguages` so new preferences have live-only scope and existing installs can still read the legacy `languages` field. Use the existing replay classification and language aliases.

## Behavior

| Setting | Live fixtures and 24/7 channels | Replay playback |
|---|---|---|
| Fresh install | Show all streams with existing default ordering. English is selected in Configure. | Existing ordering |
| Show all languages | Keep all streams. English keeps its existing priority. Other selected languages rank in the displayed selection order within the existing playback tiers. | Existing ordering |
| Only selected languages | Keep matching streams and streams whose language cannot be identified. English is eligible when selected. | Existing ordering |
| Only selected with no recognized selection | Show all streams with the existing default ordering. | Existing ordering |
| Existing URL or device with only legacy `languages` | Retain existing behavior and use the stored order to initialize Configure. | Retain legacy ordering |

The new settings travel on normal configured addon URLs and signed-in device settings. Replay Collections Copy and Download continue to serialize the existing replay settings and omit the new live-only fields.

## Task 1 — Define the controls and interaction

**File** — `public/configure.html` around `#sec-prefs`, the configuration summary, and the `/api/options` loader.

- [ ] Review the page's existing checkbox chips, preferences layout, and sticky install actions. Apply the `ui-ux-pro-max` skill to this component and reuse the page's styles and tokens.
- [ ] Put **Live commentary languages** in its own labeled group above the existing replay preferences. Use two native radios with visible labels **Show all languages** and **Only selected languages**. Show the language chips with either mode selected. Use copy that explains the actual behavior, such as **English ranks first when all languages are shown** and **Streams without an identified language stay visible**.
- [ ] Render English immediately and merge the supported options from `/api/options` into a responsive grid of labeled native checkboxes. Provide **English only** and **Clear selection** actions. Keep English and saved choices editable if loading fails. A late options response must preserve choices made while it was pending.
- [ ] Provide a labeled **Add a language** field for supported language names and codes beyond the list. Derive UI validation and canonical matching from the server's existing alias map through `/api/options`. Display saved selections during loading or failure and show inline feedback when an entry cannot be validated. Map aliases such as `es` to the existing Spanish chip. Render user-entered strings as text and handle Enter within the field.
- [ ] Maintain an ordered selection in state. Restore `Arabic, Spanish` in that order, append new choices in interaction order, and preserve order through a refresh and save. Show the effective selection order in the summary. When everything is cleared in **Only selected languages**, display **No languages selected. Showing all languages.**
- [ ] Use a fieldset and legend, keyboard-visible focus, checked indicators that work without color, and touch targets at least 44 px high. Verify that chip labels wrap and that the sticky install actions leave focused controls visible.

## Task 2 — Persist live settings and isolate replay exports

**Files** — `public/configure.html`, `src/index.js` (`/api/options`), `src/manifest.js`, and `src/auth/AuthService.js`.

- [ ] Define `liveLanguages` as an ordered comma-separated list of supported names or codes, with `none` for an explicitly cleared selection. Define `languageFilter` as `all` or `only`, defaulting to `all`. Use the existing `languages` setting to hydrate the UI when `liveLanguages` is absent. Write new choices to the live fields. Carry forward any stored legacy `languages` value verbatim so an existing install keeps its replay ordering after editing live preferences. Write an explicit `liveLanguages` value when a legacy preference is present, including `none` when cleared. Include `liveLanguages: 'English'` in **Only selected languages** mode when English is the sole selection. Omit `languageFilter` in **Show all languages** mode and omit the implicit English selection on a fresh install.
- [ ] Add the new keys to device settings and the manifest config. Keep the existing legacy key readable for installed clients. Extend the existing options response with alias data sourced from `LanguagePriorityService`; use the same canonical values in the browser and the handler.
- [ ] Update `updateLink()` and the summary. A normal install carries the live settings in its config segment, and a signed-in install uses the existing device autosave. When building both replay Collections links, remove `liveLanguages` and `languageFilter` from the serialized config and leave them out of query parameters. Retain supported legacy replay settings when present.
- [ ] Cover device config save/reload in the existing auth test harness. Verify a plain install URL round-trips Spanish-only, a device save round-trips the same selection, and switching back to **Show all languages** clears the saved restrictive mode. Compare pasted and downloaded replay exports before and after changing live settings, including a migrated install with legacy `languages: 'Arabic, Spanish'`.

## Task 3 — Apply the preference to live playback

**Files** — `src/services/LanguagePriorityService.js` and `src/streams.js`.

- [ ] Add `parseSelectedLanguages(value): string[]` using the existing aliases. Keep English, deduplicate in first-seen order, and return an empty list for absent, malformed, or unsupported input. Keep the existing priority helpers' contracts. Parse the live selection once per request so sorting and eligibility use the same preference.
- [ ] Use `isReplayCard` and the replay hub episode marker to bypass the new live preference. Continue to use legacy `languages` wherever the current handler uses it when live settings are absent. Preserve the legacy replay ordering when a request happens to carry both legacy and live settings. Use the default live ordering when the new selection is explicitly cleared.
- [ ] Use a request-local language predicate for strict mode. Resolve each row's effective language using provider metadata and the existing country/channel inference. Reuse that result for readiness, final eligibility, and labeling without mutating cached provider rows. Check eligibility before playback deduplication, fixture fallback selection, and web fallback suppression so an excluded direct or event row cannot remove an eligible alternative. Keep the existing resolution deadlines and stream policies. Attribute language exclusions correctly in candidate tracing.
- [ ] Extend `tests/languagePriority.test.js` for alias deduplication, order, explicit English, and unknown input. Extend the existing stream harness to prove Spanish-only keeps Spanish and unknown streams, excluded English cannot hide an eligible Spanish web fallback, and faster excluded results cannot satisfy readiness while a Spanish result is pending within the existing deadline. Cover 24/7 channels and replay cards, including a replay hub episode and a multipart replay. Assert that a replay request returns the same results and order with and without the new live settings.

## Task 4 — Verify Configure and playback together

- [ ] Run the affected Jest suites and syntax checks.

  ```powershell
  npm test -- tests/languagePriority.test.js tests/streamLanguageSort.test.js tests/streamPriorityQuorum.test.js tests/streamHardDeadline.test.js tests/authSso.test.js tests/localRequest.test.js
  node --check src/streams.js
  node --check src/index.js
  node --check src/services/LanguagePriorityService.js
  ```

- [ ] Run `npm test -- tests/collectionsFilter.test.js` and compare against the existing baseline. The size assertion returned 18,657 characters against a threshold of fewer than 18,650 before this work. Verify the live controls add zero characters to the corresponding replay export.
- [ ] Open Configure at desktop width and at 320 px. Using keyboard and touch, verify initial state, mode switching, selection order, alias entry, clearing, delayed and failed options loading, readable focus, and the install summary. Reload both an encoded Configure URL and a saved device. Verify a Spanish-only live response and an unchanged replay response using the resulting install configuration.
