# Google sign-in (SSO) setup — for the project owner

This guide covers everything you need to configure to turn on account sign-in with Google.
It takes about 15 minutes. Nothing here needs code changes.

## What turns on when you do this

- The **Home, Configure and Status pages require sign-in.** Signed-out visitors are sent to `/account`.
- Each signed-in user adds **devices** (a TV, a phone, the Nuvio app…) on the Account page.
  Every device has its **own sports settings** and its **own install link**, created from the Configure page.
- **Addon URLs stay open.** `/manifest.json`, catalog and stream URLs, and `/api/*` do not require a browser session,
  because Stremio and Nuvio cannot send cookies. A device link carries a revocable token instead.

If you skip this guide, the site works exactly as before and nothing is locked.

## Before you start

- The addon must be reachable on a **public HTTPS URL** (this is your `ADDON_URL`, e.g. `https://nuviosports.xyz`).
  Google only allows `http://` redirect URIs for `localhost`.
- **Node 22.13 or newer** on the server. Accounts use Node's built-in SQLite (`node:sqlite`), so no new package is
  installed and the deploy lockfile guard is not affected. Check with `node -v`.
- A Google account that will own the OAuth client.

## 1. Create the Google OAuth client

1. Open <https://console.cloud.google.com> and create a project (or pick an existing one), e.g. "Nuvio Live Sports".
2. **APIs & Services → OAuth consent screen**
   - User type: **External**.
   - Fill in the app name, user support email and developer contact email.
   - Add the scopes `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`.
     These are non-sensitive, so Google verification is **not** required.
   - While the app is in **Testing**, only people you list under **Test users** can sign in.
     Click **Publish app** when you want anyone with a Google account to be able to sign in.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**.
   - **Authorized redirect URIs** — add every origin you will use, exactly (scheme, host, port, path):
     - Production: `https://<your-domain>/api/auth/google/callback`
     - Local testing: `http://localhost:7000/api/auth/google/callback` (use your real local port)
   - Leave **Authorized JavaScript origins** empty.
4. Copy the **Client ID** and **Client secret**.

## 2. Generate the two app secrets

Run this twice, once per secret. Each must be at least 32 characters:

```bash
openssl rand -hex 32
```

| Variable | What it protects |
| --- | --- |
| `AUTH_TOKEN_PEPPER` | Hashing of session and device tokens, and signing of the sign-in state cookie |
| `AUTH_ENCRYPTION_KEY` | Encryption of each device's link token (and any per-account stream-provider install stored by the server) |

Store both somewhere safe (a password manager). **Do not commit them** — this repository is public.

## 3. Set the environment

Put these in the `.env` file next to the app on the server (it is git-ignored and loaded automatically),
or in the environment PM2 starts with:

```ini
ADDON_URL=https://your-domain.example        # public URL; also builds the Google redirect URI
AUTH_TOKEN_PEPPER=<first secret>
AUTH_ENCRYPTION_KEY=<second secret>
AUTH_GOOGLE_CLIENT_ID=<client id from Google>
AUTH_GOOGLE_CLIENT_SECRET=<client secret from Google>
```

Optional settings (defaults shown):

```ini
AUTH_DB_PATH=data/accounts.sqlite   # where accounts live (see "Data and backups")
AUTH_SESSION_TTL_HOURS=168          # how long a browser sign-in lasts (7 days)
AUTH_DEVICE_TOKEN_TTL_DAYS=0        # 0 = device install links never expire (they can still be removed)
AUTH_COOKIE_SECURE=auto             # auto | true | false — auto uses the https in ADDON_URL
```

Rules that matter:

- **Every PM2 worker must get identical values.** The app runs in cluster mode; a different secret per worker breaks sign-in.
- Accounts switch on only when **both** secrets are set and long enough. Google appears as an option only when
  the client ID and secret are both set. If either is missing the site stays open and no sign-in button is shown.
- `ADDON_URL` must be the URL users actually visit. A mismatch causes `redirect_uri_mismatch` or a lost sign-in cookie.
- Behind Cloudflare/Caddy the proxy must pass the original host and protocol (`X-Forwarded-Host`, `X-Forwarded-Proto`).
  The app already trusts the proxy headers.

## 4. Deploy

1. Add the variables on the server.
2. Run the normal deploy (the manual GitHub Actions workflow). No `npm install` is needed for this feature.
3. Restart or reload PM2 so the new environment is picked up (`pm2 reload ecosystem.config.js --update-env`).

## 5. Check it works

1. Open `https://<your-domain>/account` in a private window — you should see **Continue with Google**.
2. Sign in. You land on the account page showing your name and email.
3. **Add device**, give it a name. You are taken to Configure with that device selected.
4. Change a sport, then use **Install add-on** or **Copy link**. The link is that device's own.
5. Remove the device on the account page and open its link again — it must now return `401`.
6. Sign out with the icon in the top bar, then open `/configure` — it must redirect to the sign-in page.

## Data and backups

- Accounts, devices and settings are in **`data/accounts.sqlite`** (plus `-wal` and `-shm` files while running).
  The `data/` folder is git-ignored. **Include this file in your backups.**
- Do not reuse the name `data/auth.sqlite`; an earlier experimental branch created a file with that name and an
  incompatible layout.
- **Losing `AUTH_ENCRYPTION_KEY`** means device links can no longer be shown on the Configure page, so users would need to
  re-add their devices. **Changing `AUTH_TOKEN_PEPPER`** signs everyone out and
  invalidates every device link. Treat both like database credentials.

## What users see and what is stored

Only the Google account ID, name and email are stored, plus the settings users save. No Google password or access token is kept.
Google sign-in uses the standard authorization-code flow with PKCE, and the returned ID token is verified (signature, issuer,
audience, expiry, nonce, verified email) before an account is created.

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| No Google button, "Sign-in is not available on this server yet" | One of the four required variables is missing, or a secret is shorter than 32 characters. |
| Google shows `redirect_uri_mismatch` | The URI in Google Cloud does not match `<ADDON_URL>/api/auth/google/callback` exactly. |
| Google says the app is blocked / not verified | The consent screen is still in **Testing** and the user is not in the **Test users** list. Add them or publish the app. |
| Back on `/account?error=invalid_state` | The sign-in cookie was lost: start and callback happened on different hosts, or the proxy rewrites the host. Make `ADDON_URL` the visited URL. |
| Back on `/account?error=sign_in_failed` | Look at the server log line starting with `[auth]` — it names the failing step (token exchange, ID token check, or database). |
| Works on one PM2 worker only | The secrets differ between workers. Use the same values everywhere. |
| `node:sqlite` error at startup | Node is older than 22.13. Upgrade Node. |

## Adding another sign-in provider later

Providers live in `src/auth/providers/`. Add a module that returns `{ id, label, isConfigured(), buildAuthUrl(), exchange() }`
(copy `google.js`), list it in `src/auth/providers/index.js`, and add its client ID/secret variables. The sign-in page lists
every configured provider automatically, and accounts are keyed by provider and provider account ID.
