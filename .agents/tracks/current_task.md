# Session Checkpoint: SportzX Provider Integration & Poster Normalization
**Date**: 2026-11-23
**Status**: Completed (Pushed to `origin/stable` at `95b76c0`)

### What Was Completed
- **Poster Override Fixed**:
  - SportzX was previously passing raw individual team flag URLs (`teamAFlag`/`teamBFlag` from SofaScore/Blogger) as `thumbnail_url` and `poster`.
  - In `src/catalog.js`, Tier 1 provider artwork took precedence over the composed cinematic card generator (`imageService.matchCardUrl`), causing cards to display single raw team logos as full posters.
  - Cleared `poster: ''` and `thumbnail_url: ''` in `src/providers/SportzXProvider.js`.
  - Added an artwork filter in `src/catalog.js` ignoring raw SportzX flags/posters, ensuring Nuvio always renders its high-quality cinematic cards with proper matchup typography, sport gradients, and team badges.
- **Root Cause & Fallback**:
  - Live upstream SportzX backend (`events.json`) rotated to v4.
  - Bundled active sports catalog in `src/data/sportzx_events.json` with fallback mechanism.
  - Fixed category normalization (`info.eventType: "null"`).
- **Verification**:
  - `npm test -- tests/sportzXProvider.test.js tests/sportzXCrypto.test.js` (16 passed).
  - `node --check src/index.js`, `node --check src/catalog.js`, `node --check src/providers/SportzXProvider.js` passed.
  - Pushed commit `95b76c0` to `origin/stable`.

### VPS Deployment Instructions
On the VPS running `nuviosports.xyz`:
```bash
git pull origin stable
npm run build:local   # or pm2 restart
pm2 reload all        # or pm2 restart nuvio
```
