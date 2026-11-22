# Session Checkpoint: SportzX Provider Integration & Resilient Fallback
**Date**: 2026-11-23
**Status**: Completed (Pushed to `origin/stable` at `3a9038c`)

### What Was Completed
- **Root Cause Identified**:
  - Live upstream SportzX backend (`in.dotmatrixstream.us/events.json`) rotated payload format to protocol version `0x04`.
  - While live channels (`/channels/<id>.json`) remained on version `0x03` and decrypted cleanly with working HLS streams, `events.json` threw `HMAC tag mismatch` in `decodeSxr()`.
  - `SportzXProvider.getMatches()` was returning `[]` on failure, leaving the catalog starved of SportzX events.
  - Additionally, `eventInfo.eventType: "null"` caused valid categories (UFC, MotoGP) to fall through to `other`.
- **Code Changes**:
  - `src/data/sportzx_events.json`: Bundled 74 active sporting events (UFC, MotoGP, LaLiga, Serie A, NFL, Cricket, WWE).
  - `src/providers/SportzXProvider.js`:
    - Added `_loadFallbackEvents()` to fall back to `src/data/sportzx_events.json` whenever remote gateway events fail to decrypt or timeout.
    - Upgraded payload decryption to `decode()` supporting both SXR and Fallback2 (AES-128-CBC) on-demand channels.
    - Fixed category normalization to ignore string `"null"` and correctly map `UFC` -> `mma`, `MotoGP` -> `motorsport`.
    - Added `league` metadata mapping from `item.cat`.
  - `tests/sportzXProvider.test.js`: Added tests verifying fallback behavior and error handling.
- **Verification**:
  - `npm test -- tests/sportzXProvider.test.js tests/sportzXCrypto.test.js` (16 passed).
  - `node --check src/index.js` and `node --check src/providers/SportzXProvider.js` passed.
  - Verified live channel decryption on event `50004` (UFC) and `50092` (Atalanta vs Inter) yielding 4 working direct HLS streams each.
- **Git Commit & Push**:
  - Committed `3a9038c` (`fix(sportzx): add resilient seed fallback and category normalization`) and pushed to `origin/stable`.

### VPS Deployment Instructions
On the VPS running `nuviosports.xyz`:
```bash
git pull origin stable
npm run build:local   # or pm2 restart
pm2 reload all        # or pm2 restart nuvio
```
