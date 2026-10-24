<p align="center">
  <img src="public/logo.png" width="120" height="120" alt="Nuvio Live Sports Logo">
</p>

# 🔴 Nuvio Live Sports Addon

[![Ko-fi](https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/rajodedara)
[![GitHub](https://img.shields.io/badge/GitHub-Repository-181717?logo=github&logoColor=white)](https://github.com/rajhodedara/live-sport-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.1.3-brightgreen.svg)](#)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-52%20suites%20%7C%20656%20passed-success.svg)](#)

> ⚠️ **IMPORTANT HOSTING NOTICE:**
> **Do NOT deploy this addon to free or shared PaaS clouds like Render.com, Vercel, or Railway.** Their automated Acceptable Use Policy (AUP) scanners detect web scrapers and media proxying, which will result in **immediate and permanent suspension of your account**.
> 
> **Recommended setup:** Self-host on a spare PC / laptop / Raspberry Pi, or use a cheap unmanaged Linux VPS (e.g., Hetzner, DigitalOcean, Oracle Cloud Free Tier) using Docker or Cloudflare Tunnels (`cloudflared`).

> 🛡️ **OFFICIAL NOTICE ON THIRD-PARTY FORKS & PAID SERVICES:**
> - **100% Free & Open-Source:** This project is, and will always remain, completely free and open-source under the MIT license. **There are NO paid subscriptions, NO device limits, and NO license keys.**
> - **Unauthorized Monetization:** If any third-party fork, website, or instance claims to be this addon while selling "premium access", "license keys", or monthly subscriptions (e.g., via PayPal or crypto), **they are NOT affiliated with, supported by, or endorsed by this project**.
> - **Content Scope:** This addon exclusively indexes public live sports fixtures and replays. The official repository does not distribute or endorse adult content, shock media, or paid pirated IPTV bundles.
> - **Official Support:** The only official repository is [github.com/rajhodedara/live-sport-plugin](https://github.com/rajhodedara/live-sport-plugin). Voluntary community support is solely via [Ko-fi](https://ko-fi.com/rajodedara).

> ☕ **Enjoying Nuvio Live Sports?** Help keep the public instance alive and cover server maintenance!
> - **Credit/Debit/PayPal:** [Support on Ko-fi](https://ko-fi.com/rajodedara)
> - **Ethereum / Polygon (EVM):** `0x619eA99F0D725BEE8e0CFe9552d5F4099d15724c`
> - **Solana (SOL):** `CmuehW4PQn4yyQeXqguEpR3DjXwPPdS9Qqo4W5aWN8UU`
> - **Bitcoin (BTC):** `bc1q9dd4nflxx8ja0vzy2phzsf8h9tr6590txgd07u`

A production-grade live sports streaming add-on for [Nuvio](https://nuvio.tv) and [Stremio](https://www.stremio.com/). It serves as a high-throughput multi-source aggregator providing native live sports streams (Football, Basketball, Motorsport, Cricket, MMA, NFL, Tennis, and more) along with full match replays and 24/7 channels directly inside your player, backed by an advanced internal stream resolver to bypass CORS and ISP restrictions.

---

## 📱 App Preview & Screenshots

<p align="center">
  <img src="docs/screenshots/nuvio-live-soccer.jpg" alt="Live Sports & Soccer Catalog" width="100%">
</p>

| 🏎️ F1 & Baseball Catalogs | ⚡ 1080p Direct Stream Picker | ⚙️ Addon Details & Luffy Logo |
|:---:|:---:|:---:|
| <img src="docs/screenshots/nuvio-sports-catalog.jpg" width="100%" alt="F1 & Baseball Catalogs"> | <img src="docs/screenshots/nuvio-stream-selector.jpg" width="100%" alt="Direct Stream Selector"> | <img src="docs/screenshots/nuvio-addon-details.jpg" width="100%" alt="Addon Details"> |

---

## 🚀 Self-Hosting Guides (Recommended)

### Option 1: Docker / Docker Compose (Easiest for Servers & Raspberry Pi)

Run the addon container in seconds:

```bash
# Clone the repository
git clone https://github.com/rajhodedara/live-sport-plugin.git
cd live-sport-plugin

# Start the container in background
docker compose up -d
```

The addon is immediately available at `http://localhost:7000` (or `http://YOUR_SERVER_IP:7000`).

---

### Option 2: Local Node.js (Same Wi-Fi / Local Network or Cloudflare Tunnel)

1. **Install and run the addon:**
   ```bash
   git clone https://github.com/rajhodedara/live-sport-plugin.git
   cd live-sport-plugin
   npm install
   npm run build
   npm start
   ```

2. **Access from other Devices on the Same Wi-Fi (Phone, TV, another Laptop):**
   - Find your host computer's local IPv4 address:
     - **Windows:** Open Command Prompt (`cmd`) and run `ipconfig` (look for `IPv4 Address`, e.g., `192.168.1.50`).
     - **Mac / Linux:** Open Terminal and run `ifconfig` or `ip a` (e.g., `192.168.1.50`).
   - On any phone/tablet/laptop connected to the same Wi-Fi, open your browser:
     ```
     http://<YOUR_IPV4_ADDRESS>:7000/configure
     ```
     *(Example: `http://192.168.1.50:7000/configure`)*
   - The addon auto-detects your local LAN IP and rewrites all URLs so mobile phones and smart TVs connect without configuration errors.
   - Configure your favorite teams and sports, copy the manifest link, and paste into Nuvio / Stremio!

3. **(Optional) Expose Outside Home via Cloudflare Tunnel (`cloudflared`):**
   - Download [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
   - Run a quick tunnel:
     ```bash
     cloudflared tunnel --url http://127.0.0.1:7000
     ```
   - Open `https://your-tunnel-url.trycloudflare.com/configure` and install anywhere outside your home network!

*(Alternative: You can also use [Ngrok](https://ngrok.com) by running `ngrok http 127.0.0.1:7000`).*

---

### Option 3: Production Linux VPS with PM2 Cluster

For high concurrency on production servers, use the pre-configured [ecosystem.config.js](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/ecosystem.config.js) which includes cluster mode, jemalloc memory tuning, threadpool sizing, and stream pre-warming:

```bash
# Clone and build
git clone https://github.com/rajhodedara/live-sport-plugin.git
cd live-sport-plugin
npm install
npm run build

# Start using the production PM2 cluster configuration
npx pm2 start ecosystem.config.js
npx pm2 save
npx pm2 startup
```

---

## ⏪ Full Match Replays & Catch-Up Hubs

Never miss a game with native **Full Match Replays and Highlights** built directly into Nuvio and Stremio. Replays are organized into dynamic rolling relative date rows that calculate date ranges in real time when you open the app—eliminating stale hardcoded dates or the need to re-import JSON catalogs.

### 📅 Dynamic Rolling Relative Date Rows
Catalogs automatically adapt based on current time:
- 📅 **Today's Replays / Races / Matches** — Newly concluded fixtures from today.
- 📅 **Yesterday's Replays** — Full games and events from yesterday.
- 📅 **This Week's Replays** — Matches played over the last 2 to 7 days.
- 📅 **Older Replays** — Past games older than 7 days.
- 🏆 **All Sport Replays** — Complete historical replay archive for each sport category.

### 🏆 Supported Replay Categories & Leagues
- ⚽ **Football / Soccer:**
  - 🏴󠁧󠁢󠁥󠁮󠁧󠁿 **Premier League Replays**
  - ⭐ **UEFA Champions League & Europa League**
  - 🌍 **La Liga, Serie A, Bundesliga, Ligue 1, and International Tournaments**
- 🏎️ **Motorsport:**
  - 🏎️ **Formula 1 (F1) Grand Prix Replays** (Full Practice, Qualifying & Race sessions)
  - 🏁 **MotoGP, IndyCar, and NASCAR**
- ⚾ **Baseball:**
  - ⚾ **MLB (Major League Baseball) Replays & Full Games**
- 🏉 **Rugby:**
  - 🏉 **International Tests, Six Nations, Premiership Rugby, Super Rugby**

### ⚡ Seamless Playback & Multi-Part Coverage
- **Direct Playable TV Items:** Every replay is mapped directly as a playable video item—no fake TV show seasons, episodes, or multiple nested menus.
- **Multi-Part & Highlights Options:** Choose between full unbroken match streams, split 1st Half / 2nd Half coverage, and condensed highlight packages.
- **Nuvio Native Collections:** Built-in `/collections.json` endpoint powers horizontal landscape row browsing out-of-the-box.

---

## ✨ Key Features

- **🏟️ Multi-Source Live Aggregator:** Concurrently scrapes and unifies live fixtures from 13+ scrapers (DaddyLive, Streamed.pk, StreamFree, WatchFooty, SportyHunter, TimStreams, StreamSports99, Streamic, CDNLiveTV, DamiTV, EmbedIndia, PpvSt, ReplayZone) into a deduplicated catalog with merged stream choices.
- **⚡ Coalescing Zero-Lag HLS Manifest Proxy (`/api/manifest`):** High-speed HLS proxy powered by `impit` with persistent keep-alive connections. Coalesces concurrent in-flight upstream requests (`manifestInFlight`) to eliminate duplicate fetches during live player segment polls and prevent ISP/upstream throttling.
- **🔐 Native WebAssembly (WASM) Decryption:** Executes native WebAssembly binaries (`stream-lock.wasm`, `gasm.wasm`, `gasm_india.wasm`) directly in Node.js to decrypt obfuscated tokens and unlock protected third-party stream endpoints with zero headless browser overhead.
- **🌐 Universal Dynamic Host Routing:** Zero hardcoded local IPs. Automatically inspects incoming `Host`, `X-Forwarded-Host`, `X-Forwarded-Proto`, and `cf-visitor` headers to dynamically rewrite all manifests, streams, and asset URLs to match the client's gateway (local LAN, Cloudflare Tunnels, Ngrok, or custom domains).
- **🛡️ Opossum Circuit Breakers & Negative Caching:** Every provider scraper is isolated via an Opossum circuit breaker to instantly trip on timeouts or failures. Dead upstreams are negatively cached for 15s so video players seamlessly fail over to alternate sources without freezing.
- **🖼️ Resilient 100% 200 OK Image Pipeline (`/img`):** High-performance image proxy with LRU caching (`stale-while-revalidate`), protocol-relative normalization (`//`), and dynamic inline SVG fallback cards to ensure clients never encounter broken posters or missing team crests.
- **🛡️ Outbound SSRF Guard (`OutboundUrlGuard`):** Strict egress filtering preventing internal private network traversal and protecting local network infrastructure.
- **🧠 Algorithmic Stream Scoring & Ranking:** Evaluates and sorts stream links in real time based on resolution (1080p > 720p > SD), latency, direct M3U8 vs. webview embeds, audio commentary language, and live viewer counts.
- **🧱 Clean Architecture & Awilix IoC:** Built with Domain-Driven Design (DDD) entities (`MatchEntity`, `StreamEntity`), modular service layers, and an Awilix Inversion of Control (IoC) dependency injection container.
- **📄 Declarative YAML Provider Engine:** Includes a dynamic `YamlProviderBuilder` allowing developers to configure and plug in new stream scrapers via declarative YAML definitions without writing boilerplate.
- **⚙️ Responsive Glassmorphic Web Dashboard:** Includes a local browser player (`/`) and a full configuration interface (`/configure`) to filter sports categories, toggle active providers, localize match kickoffs to your timezone, and track favorite clubs.

---

## 🛠️ Tech Stack

| Layer | Technologies |
|---|---|
| **Runtime & Core** | [Node.js](https://nodejs.org/) (v22+ LTS), [Express.js](https://expressjs.com/) |
| **Addon Protocol** | [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk) (Stremio v1 Protocol) |
| **Architecture & IoC** | [Awilix](https://github.com/jeffijoe/awilix) (Dependency Injection / IoC Container), Domain-Driven Design (DDD) |
| **High-Performance HTTP & TLS** | [Impit](https://github.com/impit-dev/impit) (Native HTTP client with TLS/browser fingerprint impersonation), [Undici](https://undici.nodejs.org/) |
| **WASM Decryption Engines** | Native WebAssembly execution (`stream-lock.wasm`, `gasm.wasm`, `gasm_india.wasm`) |
| **Scraping & DOM Extraction** | [Cheerio](https://cheerio.js.org/), [Happy DOM](https://github.com/capricorn86/happy-dom), [jsdom](https://github.com/jsdom/jsdom), [got-scraping](https://github.com/apify/got-scraping) |
| **Resilience & Fault Tolerance** | [Opossum](https://nodeshift.dev/opossum/) (Circuit Breakers), In-Flight Request Coalescing, Negative Cache Maps |
| **Streaming & Playlists** | [m3u8-parser](https://github.com/videojs/m3u8-parser), Dynamic M3U8 segment rewriter |
| **Background Scheduling** | [node-cron](https://github.com/node-cron/node-cron) (Periodic match aggregator sync & pre-warming) |
| **Encoding & Compression** | [lz-string](https://github.com/pieroxy/lz-string) (URL-safe base64url configuration compression) |
| **Production Bundler** | [@vercel/ncc](https://github.com/vercel/ncc) (Single CJS distribution with native WASM asset copying) |

---

## 🎛️ Configuration & Environment Variables

Configure the addon by editing `.env` or setting environment variables:

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `7000` | Port the Express server listens on |
| `ADDON_URL` | *(auto-detected)* | Public base URL (e.g., `https://nuviosports.xyz`). Leave unset for auto-detection |
| `RESIDENTIAL_PROXY` | `""` | Optional residential HTTP proxy for upstream anti-bot bypass (`http://user:pass@host:port`) |
| `CF_PROXY_URL` | `""` | Optional Cloudflare Worker proxy endpoint (see [cloudflare-worker.js](file:///c:/Users/odeda/Desktop/Projects/Nuvio%20Live%20Sports%20Plugin/cloudflare-worker.js)) |
| `WARP_PROXY_URL` | `""` | Optional Cloudflare WARP SOCKS5 proxy (`socks5://127.0.0.1:40000`) |
| `PREWARM_CRON_SCHEDULE` | `*/3 * * * *` | Cron schedule for pre-warming in-flight stream resolutions |
| `PREWARM_MAX_MATCHES` | `12` | Max number of live matches to pre-warm per tick (`0` disables all prewarm jobs and fire-aheads) |

### Interactive Configuration UI (`/configure`)
Visit `http://localhost:7000/configure` to customize:
- **Sports Filtering:** Select from 14+ sports categories (Soccer, Basketball, Cricket, F1 & Racing, NFL, Hockey, Baseball, MMA, Golf, Tennis, Rugby, College Sports, Darts, Other).
- **Streaming Sources Selection:** Individually enable or disable scrapers (DaddyLive, StreamFree, TimStreams, Streamed.pk, SportyHunter, WatchFooty, CDNLiveTV, StreamSports99, Streamic, DamiTV, EmbedIndia, PpvSt, ReplayZone).
- **Localization & Timezones:** Automatically detects or manually configures your local IANA timezone to render match kick-offs in your local time.
- **Priority Tracking ("⭐ Your Teams"):** Enter comma-separated favorite clubs or athletes (e.g. `Arsenal, Lakers, Ferrari`) to dynamically generate a dedicated priority catalog.

---

## 🚀 Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Start development mode with native file watch reload
npm run dev

# 3. Build for production (bundles with @vercel/ncc and copies WASM runtimes)
npm run build

# 4. Launch compiled production server
npm start

# 5. Scaffold a new scraper from template
npm run generate:provider
```

---

## 🧪 Testing & Verification Suites

The repository contains an exhaustive test suite with **52 test suites and 656+ passing unit, integration, and load tests**:

```bash
# Run unit & service test suites with Jest
npm test

# Run simulated Stremio client E2E test (verifies manifest, catalogs, and streams)
npm run test:e2e-client

# Run live upstream scraper health check across all providers
npm run check-sources

# Validate 24/7 channels and live TV endpoints
npm run test:247

# Run performance and memory benchmarks
npm run bench

# Run heap memory benchmark
npm run bench:heap
```

---

## 📄 License & Disclaimer

This project is licensed under the [MIT License](LICENSE).

- **Personal & Educational Use:** This software is an experimental media aggregator and protocol scraper developed solely for personal, non-commercial, and educational purposes.
- **No Hosting of Media:** This addon does not host, broadcast, or store any video content or media streams on its own servers. It merely parses publicly reachable web manifests.
- **Third-Party Integrity:** The authors assume no liability for unofficial third-party forks, paid reseller bundles, or modified distributions operating under independent domains.
