# Nuvio Live Sports Plugin — Production Deployment & Architecture Handbook

This handbook documents the complete production infrastructure, configuration, daily maintenance routines, and architecture for the **Nuvio Live Sports Plugin** (`https://nuviosports.xyz`).

---

## 1. Executive Summary & Live Endpoints

| Resource | Value | Notes |
| :--- | :--- | :--- |
| **Public Manifest** | `https://nuviosports.xyz/manifest.json` | Paste into Stremio or Nuvio to install |
| **Configure Portal** | `https://nuviosports.xyz/configure` | Web dashboard to choose favorite teams / sports |
| **Server Origin IP** | `192.236.184.122` | Hidden behind Cloudflare |
| **Location** | New York, USA (RackNerd Datacenter) | Low latency to Americas and Europe |
| **Hardware Specs** | 4 vCPU Cores, 4 GB RAM, 57 GB NVMe SSD | Scaled for 10,000–15,000 users |
| **Swap Space** | 2 GB NVMe Swap (`/swapfile`) | Prevents OOM crashes during kickoff traffic spikes |
| **Runtime** | Node.js v22.23.2 LTS | High performance ES2023+ V8 engine |
| **Process Manager** | PM2 (4 Cluster Workers) | Automatic load-balancing across all 4 CPU cores |
| **Reverse Proxy** | Caddy v2.11.4 | Listens on port 80/443, routes to localhost:7000 |
| **Edge Network** | Cloudflare Anycast CDN (Free Plan) | Edge TLS termination, DDoS shield, hides origin IP (**Full (strict)** — edge↔origin encrypted) |

---

## 2. High-Performance Architecture Diagram

```
                        [ 5,000 - 15,000 Stremio / Nuvio Users ]
                                       │
                                       ▼ (HTTPS via Port 443)
                        [ Cloudflare Edge Anycast Shield ]
                         - Free Universal SSL Certificate
                         - DDoS Attack Absorption
                         - Hides Origin IP (192.236.184.122)
                         - Edge static-asset caching
                           (catalog/manifest: DYNAMIC, not edge-cached)
                                       │
                                       ▼ (HTTPS via Port 443)
                        [ RackNerd VPS: Caddy Reverse Proxy ]
                         - High-throughput Go reverse proxy
                         - Automatic header rewriting (Host, X-Real-IP)
                         - Forwards to 127.0.0.1:7000
                                       │
                                       ▼ (Internal Port 7000)
                     [ PM2 Multi-Core Cluster (4 Workers) ]
                    ┌──────────┬──────────┬──────────┬──────────┐
                    ▼          ▼          ▼          ▼
                Worker 0   Worker 1   Worker 2   Worker 3
                (Core 1)   (Core 2)   (Core 3)   (Core 4)
           all share one HTTP port :7000 (PM2 cluster)
                   │
                   ├─► each worker spawns its own resolver child:
                   │   Resolver 0-3 → :7003 :7004 :7005 :7006
                   └─► worker 0 only runs cron match syncs (single leader)
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        [ Direct Upstream CDN ]                [ Cloudflare Worker Pool ]
      - Raw .ts video segments stream        - Strips 42-byte fake WebP headers
        directly to the user's player          for Streamed.pk .image streams
      - ZERO video bandwidth on VPS          - 5 rotating workers.dev proxies
```

---

## 3. Domain & DNS Configuration

### A. Namecheap (Domain Registrar)
* **Domain**: `nuviosports.xyz`
* **WHOIS Privacy**: Enabled (Free Lifetime Privacy Protection)
* **Nameservers**: Set to **Custom DNS**:
  * `hank.ns.cloudflare.com`
  * `sky.ns.cloudflare.com`

### B. Cloudflare (DNS Zone & Security Settings)
* **DNS Records**:
  * **`A` Record**: `@` points to `192.236.184.122` (Status: **Proxied / Orange Cloud ☁️**)
  * **`CNAME` Record**: `www` points to `nuviosports.xyz` (Status: **Proxied / Orange Cloud ☁️**)
* **SSL/TLS Encryption Mode**: **Full (strict)** (migrated 2026-09-20). Cloudflare↔origin is now HTTPS end-to-end; the origin serves a Cloudflare Origin Certificate on `:443` (see §4C / §4D).
* **Always Use HTTPS**: **Enabled**
* **Automatic HTTPS Rewrites**: **Enabled**

---

## 4. Server Configuration & Setup Reference

### A. Directory Structure on VPS
```text
/root/
└── nuvio-live-sports/
    ├── dist/              # Production bundled output (built via @vercel/ncc)
    │   ├── index.js       # Main bundled entrypoint
    │   └── src/           # Resolver sources copied during build
    ├── resolver/          # Streamed.pk stream resolver & WASM decryptor
    ├── src/               # Express addon source code
    ├── .env               # Production environment variables
    └── package.json       # Dependencies & build scripts
```

### B. Production Environment (`/root/nuvio-live-sports/.env`)
```ini
PORT=7000
ADDON_URL=https://nuviosports.xyz
```

### C. Caddy Reverse Proxy Configuration (`/etc/caddy/Caddyfile`)
```caddy
nuviosports.xyz {
    tls /etc/caddy/origin.pem /etc/caddy/origin.key
    reverse_proxy 127.0.0.1:7000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto https
    }
}
```

> **Note:** serves `:443` with the Cloudflare Origin Certificate and auto-redirects `:80` → `:443` (Caddy default). This pairs with Cloudflare **Full (strict)**. The cert/key live in `/etc/caddy/` and must be readable by the `caddy` service user (`root:caddy`, mode `640`) — `chmod 600 root:root` causes `open origin.key: permission denied` and breaks the reload.

Backup before editing: `cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak`.

---

## 4D. Origin Exposure & Recommended Hardening (Full *strict*)

**Status (2026-09-20): migrated to Full (strict) — DONE.** The origin serves a Cloudflare Origin Certificate on `:443` (`/etc/caddy/origin.pem` + `origin.key`, owned `root:caddy` mode `640`), Caddy redirects `:80` → `:443`, and Cloudflare SSL mode is **Full (strict)**. Public verification: `https://nuviosports.xyz/manifest.json` → `200`, zero redirects.

**Remaining step — hide the origin behind a firewall.** The origin still accepts *direct* connections on `:80`/`:443` from any IP, so it can be reached by its raw address and bypasses Cloudflare's DDoS shield. The Origin Certificate is not publicly trusted, so a browser hitting `https://<origin-ip>` directly shows a cert warning — but a script can still reach it. Lock it down:

1. `apt update && apt install -y ufw`
2. **Allow SSH first** (or you lock yourself out): `ufw allow 22/tcp`
3. Allow only Cloudflare's ranges:
   ```bash
   for ip in $(curl -s https://www.cloudflare.com/ips-v4); do ufw allow proto tcp from $ip to any port 80;  ufw allow proto tcp from $ip to any port 443; done
   for ip in $(curl -s https://www.cloudflare.com/ips-v6); do ufw allow proto tcp from $ip to any port 80;  ufw allow proto tcp from $ip to any port 443; done
   ```
4. `ufw default deny incoming && ufw default allow outgoing && ufw enable`
5. Verify from **another machine**: the site still `200`, and `http://<origin-ip>` no longer responds. Rollback if needed: `ufw disable` (or the RackNerd VNC console if SSH is lost).

> **Failure notes from the migration:** if the origin serves a cert but Cloudflare is still *Flexible*, Caddy's `:80`→`:443` redirect causes an infinite **308 loop** (the site stops opening). The fix is to move Cloudflare to **Full (strict)**, not to disable the redirect. And `systemctl reload caddy` failing with a bare "Job failed" almost always means the cert/key isn't readable by the `caddy` user — read the real error with `caddy reload --config /etc/caddy/Caddyfile` or `journalctl -xeu caddy.service`.

---

## 5. Daily Operations & Maintenance Cheat Sheet

Connect via SSH:
```bash
ssh root@192.236.184.122
```

### How to Update After Pushing New Code to GitHub:
```bash
cd /root/nuvio-live-sports && git pull && npm run build && pm2 reload nuvio-sports
```
*(Reload is rolling / zero-downtime only when the process runs in **cluster mode** — see the start command below.)*

> ⚠️ **Deploy only ships committed code.** `git pull` fetches the remote branch; uncommitted work in the VPS working tree is not carried anywhere else, and a fresh `git pull && npm run build` can replace a locally-built (uncommitted) running binary with older committed sources. Commit or stash before deploying.

### First-time / reinstall process start (cluster mode, 4 workers):
```bash
pm2 start dist/index.js -i 4 --name nuvio-sports   # -i 4 = 4 cluster workers sharing port 7000
pm2 save
pm2 startup
```
*Without `-i 4`, PM2 runs a single fork-mode process and `pm2 reload` is not zero-downtime.*

### Process Management:
```bash
# Check worker status, memory & CPU:
pm2 status

# Live split-screen dashboard:
pm2 monit

# Temporarily stop the server:
pm2 stop nuvio-sports

# Resume the server:
pm2 start nuvio-sports

# Restart the server:
pm2 restart nuvio-sports
```

### Viewing Logs:
```bash
# Watch real-time stream resolution & user requests:
pm2 logs nuvio-sports

# View the last 50 lines without streaming:
pm2 logs nuvio-sports --lines 50 --nostream

# View ONLY errors:
pm2 logs nuvio-sports --err --lines 50

# Clear old log files:
pm2 flush
```

### Reboot Safety Checklist

Everything configured during the Full (strict) migration survives a reboot — it lives on disk (`/etc/caddy/Caddyfile`, `origin.pem`/`origin.key`) or in Cloudflare, and Caddy is systemd-enabled. The only thing that can fail to come back is **PM2**. Verify once:

```bash
systemctl is-enabled caddy        # expect: enabled
systemctl is-enabled pm2-root     # expect: enabled (the PM2 boot unit)
pm2 ls                            # expect: nuvio-sports online
```

If `pm2-root` is `disabled`/missing, register it so the app auto-starts after a reboot:
```bash
pm2 save
pm2 startup systemd -u root --hp /root   # then run the exact `sudo env ...` line it prints
pm2 save
```

After any reboot, a 30-second check:
```bash
pm2 ls                                                        # app online
curl -sI https://nuviosports.xyz/manifest.json | head -1      # HTTP/2 200
```
If the app is missing after reboot: `pm2 resurrect`. Firewall rules persist once `ufw enable` has been run (stored under `/etc/ufw`); if the site returns **502**, Caddy is up but the app on `:7000` isn't — that's the PM2 case above.

### Cluster Mode (PM2 `-i 4`) — What's Safe, What to Watch

Running 4 cluster workers is **supported by design**, not a footgun:

| Concern | Behaviour | Evidence |
| :--- | :--- | :--- |
| Duplicate cron jobs | Only **worker 0** starts cron | `src/index.js`: `if (workerOffset === 0) cronService.start()` |
| Resolver port collision | Each worker spawns its **own** resolver on a unique port | `src/resolverManager.js`: `RESOLVER_PORT = 7003 + NODE_APP_INSTANCE` |
| Shared HTTP port | All workers share `:7000` (normal Node cluster behaviour) | `app.listen(PORT)` |

Trade-offs (not breakage) to keep an eye on:
- **~4× memory**: the match cache and stream-resolve cache are **in-memory per worker** (`CacheService` holds `this.cachedMatches`), so each worker keeps its own copy.
- **Up to 4× upstream scrapes**: the scheduled sync is single-leader, but the traffic-driven re-sync (`CronService.ensureFresh`) can fire per worker under sustained load — watch provider rate-limits on a busy site.
- **Shared cache file**: `TeamLogoService` writes a cache JSON; concurrent `writeFileSync` from multiple workers is an *untested* edge (candidate, not observed).

Confirm the live mode:
```bash
pm2 ls   # Mode column = cluster; inst = 4
```
**Verified 2026-09-20** via `pm2 monit`: four `nuvio-sports` instances `[0]`–`[3]` running in **cluster mode**, ~225–327 MB RSS each (**~1 GB total** — consistent with the 4× in-memory-cache trade-off above). Heap on the sampled worker sat at ~93% of a small (~51 MiB) heap, which is normal V8 behaviour (it keeps the heap tight), not a leak on its own — only worth investigating if "Heap Size" grows steadily over time. `Restarts` was 3 with 2h uptime (stable).

If you ever see crashes on boot with `-i 4`, the resolver-port offset line above is the first thing to check.

### System Health & Resource Checks:
```bash
# Check available RAM and Swap:
free -h

# Interactive CPU and core monitor:
htop

# Check disk space:
df -h
```
