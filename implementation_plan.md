# Implementation Plan - Rolling "Relative" Date Rows for Replays & Collection Fix

Implement Option 3: Rolling "Relative" Date Rows for Replay Collections and fix the "No Items Found" issue in Nuvio Collections.

## Proposed Changes

### 1. `src/config.js`
- In `getRequestBaseUrl(req)`:
  - When `host` begins with `localhost` or `127.0.0.1`, return `BASE_URL` (`http://${getLocalIp()}:${PORT}`) instead of unreachable `localhost`, ensuring mobile devices (Android/iOS) on the network can connect.

### 2. `src/collections.js`
- Define permanent rolling relative date rows for each of the 4 sports (Football, Motorsport, Baseball, Rugby):
  - `nuvio_sports_replays_${sport}_today` (📅 Today's Replays)
  - `nuvio_sports_replays_${sport}_yesterday` (📅 Yesterday's Replays)
  - `nuvio_sports_replays_${sport}_this_week` (📅 This Week's Replays)
  - `nuvio_sports_replays_${sport}_older` (📅 Older Replays)
  - `nuvio_sports_replays_${sport}` (⚽ All ${sport} Replays)
  - Competitions (e.g. Premier League, UCL for Football; F1 for Motorsport; MLB for Baseball).
- Ensure `catalogSources` output matches the Nuvio Collections schema cleanly.

### 3. `src/catalog.js`
- In `handleReplayCatalog`:
  - Add handlers for `today`, `yesterday`, `this_week`, `older`:
    - `today`: matches from the current UTC / user day.
    - `yesterday`: matches from the previous day.
    - `this_week`: matches within the last 7 days (excluding today & yesterday).
    - `older`: matches older than 7 days.
  - Retain existing filters (`recent`, `premier_league`, `ucl`, `f1`, `mlb`, and specific dates for backward compatibility).
- Ensure replays return directly as playable `tv` items without fake `series` / `Season 1` / `Season 2` screens.

### 4. `src/manifest.js` & `src/index.js`
- In `src/manifest.js`:
  - Declare the sport replay catalogs and rolling date catalogs so Nuvio's manifest validator recognizes every catalog ID.
- In `src/index.js`:
  - Add `/api/server-info` endpoint returning `{ baseUrl: BASE_URL, localIp: getLocalIp(), port: PORT }`.
  - Ensure `/:config?/manifest.json` preserves the replay catalogs for Nuvio collection resolution.

### 5. `public/configure.html`
- When loaded on `localhost` or `127.0.0.1`, fetch `/api/server-info` to automatically display the LAN IP (`http://192.168.x.x:7000`) so the copied manifest and collection URLs are instantly reachable from mobile phones and TVs.

## Verification Plan

### Automated Tests
- Run `npx jest tests/replayHubs.test.js --runInBand --forceExit` and verify all tests pass.
- Run `npm run build` and verify bundle builds cleanly.

### Manual Verification
- Test `GET /collections.json` to verify the rolling date rows (`today`, `yesterday`, `this_week`, `older`, `all`).
- Test `GET /catalog/tv/nuvio_sports_replays_football_today.json`, `..._yesterday.json`, `..._this_week.json`.
- Test `GET /api/server-info`.
