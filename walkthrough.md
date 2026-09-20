# Walkthrough - Rolling Relative Date Rows for Replays & Collection Fix

Implemented Option 3: Dynamic rolling relative date rows for Nuvio Replay Collections, and solved the "No Items Found" issue in Nuvio.

## What Changed

### 1. Rolling Relative Date Rows (`src/collections.js`)
Instead of hardcoded dates that grow stale and require re-importing JSON files daily:
- **Football**:
  - 📅 **Today's Replays** (`nuvio_sports_replays_football_today`)
  - 📅 **Yesterday's Replays** (`nuvio_sports_replays_football_yesterday`)
  - 📅 **This Week's Replays** (`nuvio_sports_replays_football_this_week`)
  - 🏴󠁧󠁢󠁥󠁮󠁧󠁿 **Premier League Replays** (`nuvio_sports_replays_football_premier_league`)
  - ⭐ **Champions League & UEFA** (`nuvio_sports_replays_football_ucl`)
  - 📅 **Older Replays** (`nuvio_sports_replays_football_older`)
  - ⚽ **All Football Replays** (`nuvio_sports_replays_football`)
- **Motorsport**:
  - 📅 Today's Races, 📅 Yesterday's Races, 📅 This Week's Races, 🏎️ Formula 1 Replays, 📅 Older Races, 🏁 All Motorsport Replays
- **Baseball**:
  - 📅 Today's Games, 📅 Yesterday's Games, 📅 This Week's Games, ⚾ MLB Replays, 📅 Older Games, ⚾ All Baseball Replays
- **Rugby**:
  - 📅 Today's Matches, 📅 Yesterday's Matches, 📅 This Week's Matches, 📅 Older Matches, 🏉 All Rugby Replays

### 2. Rolling Relative Filtering Logic (`src/catalog.js`)
- `handleReplayCatalog` dynamically evaluates date ranges based on the exact moment the user opens Nuvio:
  - `today`: matches starting with today's UTC ISO date.
  - `yesterday`: matches starting with yesterday's UTC ISO date.
  - `this_week`: matches between 2 and 7 days ago.
  - `older`: matches older than 7 days.
  - Sub-league filters (`premier_league`, `ucl`, `f1`, `mlb`, etc.) are preserved.
- All matches return directly as playable `tv` items with landscape thumbnails.

### 3. Solved "No Items Found" in Nuvio
- **Localhost vs LAN IP Resolution (`src/config.js` & `public/configure.html`)**:
  - When accessing `/configure` or generating collections from PC (`localhost`), mobile phones on the Wi-Fi cannot connect to `localhost`.
  - Added `/api/server-info` endpoint.
  - `getRequestBaseUrl` in `src/config.js` and `configure.html` now automatically replace `localhost` / `127.0.0.1` with the machine's LAN IP (`http://192.168.x.x:7000`), so the copied Collection URL and JSON are 100% accessible to external phones and TVs.
- **Manifest Catalog Registration (`src/manifest.js` & `src/index.js`)**:
  - Registered `nuvio_sports_replays_football`, `nuvio_sports_replays_motorsport`, `nuvio_sports_replays_baseball`, and `nuvio_sports_replays_rugby` in `manifest.catalogs` so Nuvio's manifest validator immediately recognizes them and allows pulling items without returning "no items found".

## Verification Results

### Automated Tests
- `npx jest tests/replayHubs.test.js --runInBand --forceExit` passed (9/9 passed).
- `npm run build` completed successfully.

### Manual Verification
- `GET /collections.json`: Verified rolling relative date rows are returned for all 4 sports.
- `GET /catalog/tv/nuvio_sports_replays_football_yesterday.json`: Returned yesterday's football matches (6 matches).
- `GET /catalog/tv/nuvio_sports_replays_football_this_week.json`: Returned this week's football matches (17 matches).
- `GET /api/server-info`: Returned `{ baseUrl: 'http://192.168.0.123:7000', localIp: '192.168.0.123', port: 7000 }`.
- Server restarted and running on port 7000.
