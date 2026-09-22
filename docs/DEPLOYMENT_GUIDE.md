# Nuvio Live Sports Plugin - Production Deployment & Architecture Handbook

This handbook documents the production infrastructure, configuration, daily maintenance
routines, and architecture for the **Nuvio Live Sports Plugin** (`https://nuviosports.xyz`).

> **SECURITY NOTE (read first).** This repository is **public**. Do not commit the origin
> server's IP address, provider/datacenter name, hostnames, credentials, keys, or `.env`
> contents. The origin IP for this deployment has **already been exposed in an earlier
> revision of this file** and must therefore be treated as **public and permanently
> burned**: it cannot be un-leaked by editing files, because it remains in git history,
> in forks, and in any cache. The only way to obtain a private origin again is to request
> a new IP from the provider. Until then, assume an attacker can address the origin
> directly and firewall accordingly (see section 4D).

---

## 1. Executive Summary & Live Endpoints

| Resource | Value | Notes |
| :--- | :--- | :--- |
| **Public Manifest** | `https://nuviosports.xyz/manifest.json` | Paste into Stremio or Nuvio to install |
| **Configure Portal** | `https://nuviosports.xyz/configure` | Web dashboard to choose favorite teams / sports |
| **Server Origin** | `<VPS_HOST>` | Private. Never commit the real value. Reachable only via SSH |
| **Location** | Undisclosed | Do not record provider or datacenter in this file |
| **Host Sizing** | Small managed VPS | Sized for a few thousand concurrent users |
| **Runtime** | Node.js 22 LTS | Do not pin patch versions in this file |
| **Process Manager** | PM2 (cluster workers) | Load-balances across available CPU cores |
| **Reverse Proxy** | Caddy v2 | Terminates TLS, routes to a local-only app port |
| **Edge Network** | Cloudflare (proxied) | Edge TLS, DDoS shield, origin IP hiding |

Keep `<VPS_HOST>` as a literal placeholder in this document and substitute the real value
locally when you need it.

---

## 2. Architecture Overview

```
                        [ Stremio / Nuvio users ]
                                    |
                                    v  (HTTPS 443)
                        [ Cloudflare Edge (proxied) ]
                         - Universal SSL
                         - DDoS absorption
                         - Hides the origin address
                         - Dynamic catalog/manifest (not edge-cached)
                                    |
                                    v  (HTTPS 443)
                        [ VPS: Caddy reverse proxy ]
                         - Terminates TLS (Cloudflare Origin Certificate)
                         - Rewrites Host / X-Real-IP / X-Forwarded-*
                         - Forwards to 127.0.0.1:<APP_PORT>
                                    |
                                    v  (internal app port)
                        [ PM2 cluster (N workers, one shared port) ]
                         - Worker 0 only runs the cron match sync
                         - Each worker spawns its own resolver child
                                    |
                    +---------------+----------------+
                    v                                v
        [ Direct upstream CDN ]           [ Cloudflare Worker pool ]
      - Raw .ts segments stream        - Rewrites fake image headers
        to the user's player             for certain upstream streams
      - Zero video bandwidth on VPS
```

---

## 3. Domain & DNS Configuration

### A. Registrar (domain)
* **Domain**: `nuviosports.xyz`
* **WHOIS Privacy**: Enabled
* **Nameservers**: Custom DNS, pointing at Cloudflare

### B. Cloudflare (DNS zone & security)
* **DNS Records**:
  * **`A`** `@` -> `<VPS_HOST>`, **Proxied** (orange cloud)
  * **`CNAME`** `www` -> `nuviosports.xyz`, **Proxied** (orange cloud)
* **SSL/TLS mode**: **Full (strict)** - edge-to-origin is HTTPS end to end; the origin
  serves a Cloudflare Origin Certificate on `:443`.
* **Always Use HTTPS**: Enabled
* **Automatic HTTPS Rewrites**: Enabled

---

## 4. Server Configuration & Setup Reference

### A. Directory structure on the VPS
```text
/root/
  nuvio-live-sports/
    dist/              # Production bundle (built via @vercel/ncc)
      index.js         # Bundled entrypoint
      src/             # Resolver sources copied during build
    resolver/          # Stream resolver & WASM decryptor
    src/               # Express addon source
    .env               # Production environment variables (never commit)
    package.json
```

### B. Production environment (`/root/nuvio-live-sports/.env`)
```ini
PORT=<APP_PORT>
ADDON_URL=https://nuviosports.xyz
```
Keep `.env` out of git. It is already listed in `.gitignore`; confirm before every commit.

### C. Caddy reverse proxy (`/etc/caddy/Caddyfile`)
```caddy
nuviosports.xyz {
    tls /etc/caddy/origin.pem /etc/caddy/origin.key
    reverse_proxy 127.0.0.1:<APP_PORT> {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto https
    }
}
```

> **Note:** serves `:443` with the Cloudflare Origin Certificate and redirects `:80` to
> `:443` (Caddy default). Pairs with Cloudflare **Full (strict)**. The cert/key live in
> `/etc/caddy/` and must be readable by the `caddy` service user (`root:caddy`, mode
> `640`) - `chmod 600 root:root` causes `open origin.key: permission denied` and breaks reload.

Back up before editing: `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak`.

---

## 4D. Origin Exposure & Required Hardening

**Status (2026-09-20): Cloudflare is on Full (strict).** The origin serves a Cloudflare
Origin Certificate on `:443`, Caddy redirects `:80` to `:443`, and Cloudflare SSL mode is
**Full (strict)**. Verified with `curl -sI https://nuviosports.xyz/manifest.json` -> `200`.

**Outstanding risk - the origin address is public.** The origin IP was previously written
into this repository and is therefore known. An attacker can try to reach the origin
directly and bypass Cloudflare's DDoS shield. Lock this down, in this order:

1. `apt update && apt install -y ufw`
2. **Allow SSH first** (or you will lock yourself out): `ufw allow 22/tcp`
3. Allow only Cloudflare's ranges on 80/443:
   ```bash
   for ip in $(curl -s https://www.cloudflare.com/ips-v4); do ufw allow proto tcp from $ip to any port 80;  ufw allow proto tcp from $ip to any port 443; done
   for ip in $(curl -s https://www.cloudflare.com/ips-v6); do ufw allow proto tcp from $ip to any port 80;  ufw allow proto tcp from $ip to any port 443; done
   ```
4. `ufw default deny incoming && ufw default allow outgoing && ufw enable`
5. Verify from **another machine**: the site still returns `200`, and the raw origin address
   no longer responds. Rollback: `ufw disable` (or the provider's VNC console if SSH is lost).

**Harden SSH (do this as well).** Open SSH on a public IP is the highest-value target:

* `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config`
* `PasswordAuthentication no` (key-only)
* Restrict `22/tcp` to your own admin address in `ufw`, or move SSH behind
  Cloudflare Tunnel / a bastion
* `apt install -y fail2ban` with an `sshd` jail
* Reload with `systemctl reload ssh` and keep your current session open until you have
  confirmed a fresh login works

**To actually re-hide the origin:** request a new IP from the provider, re-point DNS, then
follow steps 1-5. Editing files cannot undo the exposure.

> **Failure notes from the migration:** if the origin serves a cert but Cloudflare is still
> *Flexible*, Caddy's `:80` -> `:443` redirect causes an infinite **308 loop** (the site
> stops opening). Fix: move Cloudflare to **Full (strict)**; do not disable the redirect.
> And `systemctl reload caddy` failing with a bare "Job failed" almost always means the
> cert/key is not readable by the `caddy` user - read the real error with
> `caddy reload --config /etc/caddy/Caddyfile` or `journalctl -xeu caddy.service`.

---

## 5. Daily Operations & Maintenance

Connect via SSH (substitute your own host; never commit the value):
```bash
ssh <user>@<VPS_HOST>
```

### How to update after pushing new code to GitHub
```bash
cd /root/nuvio-live-sports && git pull && npm run build && pm2 reload nuvio-sports
```
*(Reload is rolling / zero-downtime only when the process runs in **cluster mode** - see the
start command below.)*

> **Deploy only ships committed code.** `git pull` fetches the remote branch; uncommitted
> work in the VPS working tree is not carried anywhere else, and a fresh
> `git pull && npm run build` can replace a locally-built (uncommitted) running binary with
> older committed sources. Commit or stash before deploying.

### First-time / reinstall process start (cluster mode)
```bash
pm2 start dist/index.js -i <WORKERS> --name nuvio-sports   # one worker per CPU core
pm2 save
pm2 startup
```
*Without the `-i` flag, PM2 runs a single fork-mode process and `pm2 reload` is not
zero-downtime.*

### Process management
```bash
pm2 status                 # worker status, memory & CPU
pm2 monit                  # live dashboard
pm2 stop nuvio-sports      # temporarily stop
pm2 start nuvio-sports     # resume
pm2 restart nuvio-sports   # restart
```

### Logs
```bash
pm2 logs nuvio-sports                     # real-time
pm2 logs nuvio-sports --lines 50 --nostream
pm2 logs nuvio-sports --err --lines 50    # errors only
pm2 flush                                 # clear old logs
```

### Reboot safety checklist

Everything configured during the Full (strict) migration survives a reboot - it lives on
disk (`/etc/caddy/Caddyfile`, `origin.pem`/`origin.key`) or in Cloudflare, and Caddy is
systemd-enabled. The only thing that can fail to come back is **PM2**. Verify once:

```bash
systemctl is-enabled caddy        # expect: enabled
systemctl is-enabled pm2-root     # expect: enabled (the PM2 boot unit)
pm2 ls                            # expect: nuvio-sports online
```

If `pm2-root` is `disabled`/missing, register it so the app auto-starts after a reboot:
```bash
pm2 save
pm2 startup systemd -u root --hp /root   # then run the exact command it prints
pm2 save
```

After any reboot, a 30-second check:
```bash
pm2 ls
curl -sI https://nuviosports.xyz/manifest.json | head -1   # HTTP/2 200
```
If the app is missing after reboot: `pm2 resurrect`. Firewall rules persist once
`ufw enable` has been run (stored under `/etc/ufw`); if the site returns **502**, Caddy is
up but the app is not - that is the PM2 case above.

### Cluster mode - what is safe, what to watch

Running a multi-worker cluster is **supported by design**, not a footgun:

| Concern | Behaviour | Evidence |
| :--- | :--- | :--- |
| Duplicate cron jobs | Only worker 0 starts cron | `src/index.js`: `if (workerOffset === 0) cronService.start()` |
| Resolver port collision | Each worker spawns its own resolver on a unique port | `src/resolverManager.js` |
| Shared HTTP port | All workers share one port (normal Node cluster behaviour) | `app.listen(PORT)` |

Trade-offs (not breakage) to watch:
- **Memory scales with workers**: the match cache and stream-resolve cache are in-memory
  **per worker** (`CacheService` holds `this.cachedMatches`), so each worker keeps its own copy.
- **Up to N x upstream scrapes**: the scheduled sync is single-leader, but the traffic-driven
  re-sync (`CronService.ensureFresh`) can fire per worker under sustained load - watch provider
  rate limits on a busy site.
- **Shared cache file**: `TeamLogoService` writes a cache JSON; concurrent `writeFileSync`
  from multiple workers is an *untested* edge (candidate, not observed).

Confirm the live mode:
```bash
pm2 ls   # Mode column = cluster
```

### System health checks
```bash
free -h    # RAM and swap
htop       # CPU and cores
df -h      # disk space
```
