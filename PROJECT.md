# Project: Nuvio Live Sports Plugin — Dynamic Host Routing, Thumbnail Repair, & E2E Sanity Testing

## Architecture
Nuvio Live Sports Plugin is a Stremio v1 protocol addon built with Node.js/Express. It aggregates live sports fixtures and 24/7 sports TV channels from multiple providers (StreamedPk, StreamFree, WatchFooty, SportyHunter, TimStreams, IptvOrg, etc.), transforms them into Stremio catalogs/metadata/streams, and proxies media streams and images safely.

### Key Subsystems:
1. **Host & Routing Layer (`src/config.js`, `src/index.js`)**:
   - Dynamic non-internal IPv4 detection via `os.networkInterfaces()` for local LAN fallback (zero hardcoded strings).
   - Dynamic `getRequestBaseUrl(req)` resolving `X-Forwarded-Proto`, `X-Forwarded-Host`, `Host`, `req.protocol`, `cf-visitor`, and `x-forwarded-ssl`.
   - Universal Dynamic Base URL Response Rewriter interceptor in `src/index.js` across `/manifest.json`, `/:config/manifest.json`, `/catalog/*`, `/meta/*`, and `/stream/*`.
2. **Catalog & Asset Serving Layer (`src/catalog.js`, `src/services/ImageService.js`, `src/services/MatchAggregator.js`)**:
   - URL normalization for protocol-relative (`//`), relative, and external image URLs.
   - Match deduplication preserving `thumbnail_url`, `team1.logo`, `team2.logo`, and `background`.
   - Built-in `/img` caching proxy (10-min LRU cache) and `/img/placeholder` SVG fallback ensuring 100% HTTP 200 OK delivery with CORS headers.
3. **E2E Testing & Verification Layer (`scripts/test-e2e-simulated-client.js`)**:
   - Standalone automated simulated Stremio client test runner verifying manifest, catalog, thumbnails, stream resolution, M3U8 playback, dynamic hosts, and zero hardcoded IPs.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Zero Hardcoded IPs | Remove `192.168.0.123` from `src/config.js` and `.env`; use dynamic IPv4 auto-detection | M1 | Survey E1 |
| 2 | Dynamic Request Host Resolution | Implement `getRequestBaseUrl(req)` supporting `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `cf-visitor` | M1 | Survey E1 |
| 3 | Universal Response Rewriter | Intercept Stremio JSON responses to dynamically rewrite internal asset/stream URLs to request host | M1 | Survey E1, E2 |
| 4 | Thumbnail URL Normalization | Support protocol-relative `//` URLs, leading slashes, and provider base URLs | M2 | Survey E2 |
| 5 | Deduplication Image Preservation | Preserve team logos, thumbnails, and backgrounds during match merging in `MatchAggregator.js` | M2 | Survey E2 |
| 6 | 100% 200 OK Resilient Image Proxy | Provide image proxy and category-colored SVG fallback cards on dead/slow image upstreams | M2 | Survey E2 |
| 7 | Simulated Stremio Client Test Runner | Comprehensive E2E script simulating full Stremio client workflow and verifying all endpoints | M3 | Survey E3 |
| 8 | Codebase Static IP & Security Audit | Static check ensuring 0 hardcoded `192.168.0.` strings across codebase and package build synchronization | M3 | Survey E1, E3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Dynamic Host Routing | `src/config.js`, `.env`, `src/index.js` (middleware + trust proxy) | none | DONE |
| 2 | Thumbnail Repair & Image Proxy | `src/services/ImageService.js`, `src/catalog.js`, `src/services/MatchAggregator.js`, providers | M1 | DONE |
| 3 | E2E Simulated Client Test Suite | `scripts/test-e2e-simulated-client.js`, `package.json`, verification | M1, M2 | DONE |
| 4 | Verification, Challenge & Audit | Multi-agent review, challenger stress-tests, forensic integrity audit | M1, M2, M3 | DONE |

## Code Layout & Write Boundaries
- `src/config.js`: Dynamic IP detection and `getRequestBaseUrl(req)` helper.
- `src/index.js`: Express configuration, `trust proxy`, universal response rewriter middleware, `/img` and `/img/placeholder` routes.
- `.env`: Clean configuration without hardcoded local IP.
- `src/services/ImageService.js`: Image fetching, protocol-relative normalization, LRU cache, SVG fallback generator.
- `src/catalog.js`: Catalog mapping, thumbnail normalization, team logo fallback hierarchy.
- `src/services/MatchAggregator.js`: Deduplication logic preserving image assets.
- `src/providers/*.js`: Provider scrapers with normalized image and proxy URLs.
- `scripts/test-e2e-simulated-client.js`: Automated E2E test runner.
- `package.json`: NPM test scripts and dependencies.

## Reference Documentation
- `docs/DEPLOYMENT_GUIDE.md`: VPS deployment topology (Cloudflare -> Caddy -> PM2), DNS/TLS setup, and operational checks.
- `docs/DADDYLIVE_IFRAME_DOMAINS.md`: How DaddyLive-family streams resolve, which embed domains exist, and their decoder strategies.
- `docs/BANDWIDTH_AND_CACHING.md`: Where egress actually goes, why Cloudflare caches by file extension, the applied `/posters` + artwork fixes, and the `/img` Cache Rule (deployed 2026-09-24). **Read this before touching `public/posters/`, the `/posters` static mounts, or the `/img*` routes.**
