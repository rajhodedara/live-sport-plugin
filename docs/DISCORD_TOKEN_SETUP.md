# Discord `/token` Sign-In Setup — for the project owner

This guide covers everything needed to register `/token` in Discord, enable Discord access-token sign-in on `/account`, and verify it live without adding Discord OAuth.

## How the flow works

1. An eligible member runs `/token` in the configured Nuvio Discord server.
2. Discord sends an Ed25519-signed `POST` to `<ADDON_URL>/api/auth/discord/interactions`.
3. Nuvio verifies the signature, timestamp window, application ID, server ID, and optional role ID, then issues a permanent, reusable `nt_...` token and replies **privately** (ephemeral message, only visible to that user).
4. The member opens `<ADDON_URL>/account`, selects **Access token**, and pastes the token.
5. `POST /api/auth/access-token/redeem` validates the canonical browser origin, atomically claims the token in SQLite (`data/accounts.sqlite`), creates or reuses the `discord`-provider account (storing **only** display name and Discord user ID, never email), sets the `nuvio_session` cookie, and redirects to the destination (for example `/configure`).
6. Existing public add-on URLs (`/manifest.json`, `/catalog/*`, `/meta/*`, `/stream/*`, and installed `/<device-config>/manifest.json` links) keep working unchanged.

## Before you start

- **Node 22.13 or newer** (for built-in `node:sqlite`).
- **A canonical HTTPS `ADDON_URL`** reachable by Discord (for production, e.g. `https://nuviosports.xyz`; for local live testing with Discord, expose local port `7000` over an HTTPS tunnel such as Cloudflare Tunnel `cloudflared tunnel --url http://localhost:7000` and set `ADDON_URL` to that tunnel's `https://` origin).
  - Plain `http://` is accepted **only** for loopback (`http://localhost:7000` / `http://127.0.0.1:7000`) when running offline/local interaction tests.
- Existing `AUTH_TOKEN_PEPPER` and `AUTH_ENCRYPTION_KEY` secrets (`>= 32` characters each, identical across all PM2 workers; see `docs/GOOGLE_SSO_SETUP.md`).

## 1. Create and configure the Discord Application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application** (for example, `Nuvio Live Sports`).
2. On **General Information**:
   - Copy **Application ID** -> this is `AUTH_DISCORD_APPLICATION_ID`.
   - Copy **Public Key** (64-character hex string) -> this is `AUTH_DISCORD_PUBLIC_KEY`.
   - Set **Interactions Endpoint URL** to:
     ```text
     <ADDON_URL>/api/auth/discord/interactions
     ```
     > **Important:** Start Nuvio with the environment variables below **before** clicking **Save Changes** in the Developer Portal. Discord immediately sends a signed `PING` (`type: 1`) and refuses to save unless Nuvio responds with `200 { "type": 1 }`.
3. On **OAuth2 -> URL Generator** (to add `/token` to your server without enabling Discord OAuth login on the website):
   - Under **Scopes**, check **`applications.commands`** only (no `identify` or `email` OAuth redirect is needed or used by the addon).
   - Open the generated URL and authorize the application into your Nuvio Discord server.
4. On **Bot** (used **only once** as an admin credential to register the `/token` slash command — never put the Bot Token in `.env`, runtime config, or browser code):
   - Click **Reset Token** and copy the Bot Token temporarily to a local shell variable for Step 3.

## 2. Find your Server (Guild) ID and optional Role ID

1. In Discord, open **User Settings -> Advanced** and enable **Developer Mode**.
2. Right-click the Nuvio Discord server icon -> **Copy Server ID** -> this is `AUTH_DISCORD_GUILD_ID`.
3. *(Optional role gate)* Right-click a role in **Server Settings -> Roles** -> **Copy Role ID** -> this is `AUTH_DISCORD_ROLE_ID`.
   - Leave `AUTH_DISCORD_ROLE_ID` empty to allow any current member of `AUTH_DISCORD_GUILD_ID` to generate tokens.
   - When set, Discord includes `member.roles` in the signed interaction payload and Nuvio checks that role at `/token` issuance time. Existing sessions and device links keep their normal lifetime if a member leaves or loses the role later.

## 3. Register the guild-scoped `/token` slash command

Register `/token` as a **guild command** (`type: 1` `CHAT_INPUT`) so it appears immediately in your server and stays scoped to `AUTH_DISCORD_GUILD_ID`. Keep `DISCORD_BOT_TOKEN` out of `.env` and out of the app runtime.

**Linux / macOS (`curl`):**

```bash
export DISCORD_APP_ID="<your AUTH_DISCORD_APPLICATION_ID>"
export DISCORD_GUILD_ID="<your AUTH_DISCORD_GUILD_ID>"
export DISCORD_BOT_TOKEN="<temporary bot token>"

curl -sS -X POST \
  "https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${DISCORD_GUILD_ID}/commands" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "token",
    "type": 1,
    "description": "Get a private, single-use sign-in token for Nuvio Live Sports"
  }'
```

**Windows PowerShell:**

```powershell
$appId = "<your AUTH_DISCORD_APPLICATION_ID>"
$guildId = "<your AUTH_DISCORD_GUILD_ID>"
$botToken = "<temporary bot token>"

Invoke-RestMethod -Method Post `
  -Uri "https://discord.com/api/v10/applications/$appId/guilds/$guildId/commands" `
  -Headers @{ Authorization = "Bot $botToken" } `
  -ContentType "application/json" `
  -Body '{"name":"token","type":1,"description":"Get a private, single-use sign-in token for Nuvio Live Sports"}'
```

## 4. Environment variables

Set these in `.env` (or PM2 environment — **identical values on every PM2 worker**):

```ini
ADDON_URL=https://your-domain.example
AUTH_TOKEN_PEPPER=<at least 32 chars, e.g. openssl rand -hex 32>
AUTH_ENCRYPTION_KEY=<at least 32 chars, e.g. openssl rand -hex 32>
AUTH_DB_PATH=data/accounts.sqlite

# Discord /token sign-in
AUTH_DISCORD_APPLICATION_ID=<17-22 digit Application ID>
AUTH_DISCORD_PUBLIC_KEY=<64-char hex Ed25519 Public Key>
AUTH_DISCORD_GUILD_ID=<17-22 digit Server/Guild ID>
AUTH_DISCORD_ROLE_ID=             # optional: 17-22 digit Role ID; blank = all guild members
```

Notes:
- Google OAuth (`AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET`) is independent and optional. You can enable Google only, Discord `/token` only, or both together.
- If any required `AUTH_DISCORD_*` variable is missing or malformed (including a non-snowflake `AUTH_DISCORD_ROLE_ID`), or if `ADDON_URL` is unset or non-canonical, Nuvio fails closed and disables the Discord `/token` method.

## 5. Reverse proxy and trusted-edge rate-limit requirement

- **`POST /api/auth/access-token/redeem`** validates that the browser `Origin` matches `ADDON_URL` exactly (scheme, host, and port) before touching SQLite, and applies an in-memory per-IP rate limit keyed by the trusted proxy's client IP (`CF-Connecting-IP` -> `X-Real-IP` -> rightmost `X-Forwarded-For` when arriving from a loopback/private proxy).
- **Required proxy hygiene:** Your edge/reverse proxy (Cloudflare + Caddy/nginx) **must** overwrite/strip client-supplied `CF-Connecting-IP` and `X-Real-IP` (or append the real peer IP to `X-Forwarded-For`) and enforce an edge rate limit on `POST /api/auth/access-token/redeem` (and `POST /api/auth/discord/interactions` if desired, while leaving Discord's webhook bursts unblocked) because in-process counters are per-worker and reset on restart.
- Forward requests for `/api/auth/discord/interactions` directly to Nuvio without adding CORS/Origin rewrites or buffering delays (Discord expects an initial response within 3 seconds).

## 6. Local testing and verification checklist

1. Run the auth test suite locally:
   ```bash
   npm test -- tests/authSso.test.js tests/discordTokenAuth.test.js tests/localRequest.test.js
   ```
2. For **live local Discord testing** before production rollout:
   - Start a temporary HTTPS tunnel pointing to `http://localhost:7000` (e.g. `cloudflared tunnel --url http://localhost:7000`).
   - Put the tunnel's `https://...` origin in `ADDON_URL` and configure the `AUTH_DISCORD_*` variables in `.env`, then start `npm run dev`.
   - Save `<ADDON_URL>/api/auth/discord/interactions` as the **Interactions Endpoint URL** in the Discord Developer Portal and confirm Discord accepts the `PING` verification.
   - Register `/token` in your test server (Step 3).
   - Run `/token` as an eligible member (and verify an ineligible user/role receives a private refusal with no token minted).
   - Open `<ADDON_URL>/account` (or `<ADDON_URL>/configure`, which redirects to `/account?next=%2Fconfigure`), paste the token into **Access token**, and confirm:
     - Sign-in succeeds, clears the token field, and redirects back to `/configure`.
     - Re-submitting the same token fails with `"This token is invalid, expired, or already used. Run /token in Discord to get a new one."`.
     - Creating a device and opening its `/<config>/manifest.json` link works, and existing public `/manifest.json`, `/catalog/*`, and `/stream/*` routes continue returning expected responses.

## 7. Rollback

To disable Discord `/token` sign-in without touching Google SSO, existing browser sessions, or installed device links:

1. Remove or blank `AUTH_DISCORD_APPLICATION_ID`, `AUTH_DISCORD_PUBLIC_KEY`, `AUTH_DISCORD_GUILD_ID`, and `AUTH_DISCORD_ROLE_ID` in the server `.env` / PM2 environment.
2. Reload PM2 (`pm2 reload ecosystem.config.js --update-env`).
3. `/api/auth/providers` immediately reports `accessTokenEnabled: false`, `/account` hides the **Access token** tab/form, and Google SSO (if configured) plus existing sessions and device tokens continue working normally.
