# Nuvio Live Sports Plugin — Public Production Deployment & Architecture Guide

This document captures the complete infrastructure setup, decisions, commands executed, DNS records, and architecture configured for hosting the **Nuvio Live Sports Plugin** publicly for **5,000 to 15,000 concurrent users**.

---

## 1. Core Architecture Overview

To support 10,000–15,000 users on a budget VPS without facing high cloud bandwidth bills or upstream IP bans, we adopted the **Hybrid Edge / Direct-CDN Model** (the same architectural pattern proven by top community addons like `pengu.uk`):

```
                        [ 5k - 15k Public Users / Stremio Apps ]
                                       │
                                       ▼ (HTTPS)
                        [ Cloudflare Edge Anycast CDN ]
                         - Free SSL Termination
                         - DDoS Mitigation
                         - Masks Origin VPS IP
                         - Edge Static Asset Caching
                                       │
                                       ▼ (Port 80 / 443)
                        [ RackNerd VPS: Caddy Reverse Proxy ]
                         - High-performance Go-based web server
                         - Automatic SSL / HTTP/3
                         - Reverse-proxies traffic to internal Node.js
                                       │
                                       ▼ (Localhost: 7000)
                        [ PM2 Cluster: Node.js 22 LTS Engine ]
                         - Nuvio Live Sports Plugin (Express)
                         - Streamed.pk Resolver Child Process
                         - In-flight deduplication (`manifestInFlight`)
                         - Dynamic M3U8 Playlist Rewriting
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        [ Direct Upstream CDN ]                [ Cloudflare Worker ]
      - Player streams raw .ts video          - Strips fake 42-byte .image
        directly from provider CDNs             WebP/RIFF headers for Streamed.pk
      - ZERO video bandwidth on VPS             (Zero video bandwidth on VPS)
```

---

## 2. Infrastructure Inventory & Credentials Overview

| Asset | Details | Purpose |
| :--- | :--- | :--- |
| **Server Provider** | RackNerd KVM VPS | Dedicated production hosting |
| **Server Spec** | 4 vCPU Cores, 4 GB RAM, 57 GB NVMe SSD | Scalable up to 15,000 users |
| **Server Location** | New York, USA (`192.236.184.122`) | Low latency to US and Europe |
| **Operating System** | Ubuntu 24.04 LTS (x86_64) | Production Linux OS |
| **Domain Name** | `nuviosports.xyz` | Official public addon domain |
| **Domain Registrar** | Namecheap (Paid with Bitcoin/Crypto) | Domain ownership & WHOIS privacy |
| **DNS & Edge Shield** | Cloudflare (Free Plan) | Nameservers, SSL, DDoS & IP mask |
| **Node.js Runtime** | Node.js v22.23.2 LTS + npm 10.9.8 | Runtime executing the plugin |
| **Process Manager** | PM2 | Background 24/7 cluster supervisor |
| **Reverse Proxy** | Caddy v2 | Port 80/443 SSL & reverse proxy |

---

## 3. Domain & DNS Configuration

### A. Namecheap (Registrar)
* **Domain**: `nuviosports.xyz`
* **Privacy**: Free Domain Privacy enabled (protects personal identity in public WHOIS).
* **Nameservers**: Changed from *Namecheap BasicDNS* to **Custom DNS**:
  * `hank.ns.cloudflare.com`
  * `sky.ns.cloudflare.com`

### B. Cloudflare (DNS Zone & Security Proxy)
The domain zone was onboarded to Cloudflare Free. The following DNS records route all user traffic through Cloudflare's protected edge:

| Record Type | Name | Content / Target | Proxy Status | Description |
| :--- | :--- | :--- | :--- | :--- |
| **A** | `@` (root) | `192.236.184.122` | **Proxied (Orange Cloud ☁️)** | Resolves `https://nuviosports.xyz` to VPS while hiding origin IP |
| **CNAME** | `www` | `nuviosports.xyz` | **Proxied (Orange Cloud ☁️)** | Resolves `https://www.nuviosports.xyz` to root |

#### Cloudflare SSL/TLS Settings:
* **Mode**: **Full** (or **Flexible**)
* **Always Use HTTPS**: Enabled
* **Automatic HTTPS Rewrites**: Enabled

---

## 4. Server-Side Execution Log (What Was Configured on VPS)

All commands executed inside the VPS terminal (`root@racknerd-ee1eb31`):

### Step 1: Fix Initial DNS Resolver on Ubuntu
RackNerd's fresh image had an unconfigured nameserver resolver, which was fixed by adding Google and Cloudflare public resolvers:
```bash
echo "nameserver 8.8.8.8" > /etc/resolv.conf
echo "nameserver 1.1.1.1" >> /etc/resolv.conf
```
*Verification*: Successfully pinged `google.com` with `0% packet loss` and `22.7ms` latency.

### Step 2: 2 GB Swap Memory Safeguard
Created an emergency NVMe-backed swapfile so Linux will never kill the Node.js process during high-concurrency matchday spikes:
```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Step 3: Node.js 22 LTS, Build Tools & PM2
Installed official NodeSource Node 22 repository, essential build compilers, and PM2 process supervisor:
```bash
apt update && apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
```
*Verified Versions*:
* **Node**: `v22.23.2`
* **NPM**: `10.9.8`
* **PM2**: `5.4.3`

---

## 5. Next Actions to Finish Deployment

The remaining steps to bring `https://nuviosports.xyz` live:

1. **Install and configure Caddy**:
   Set `/etc/caddy/Caddyfile` to proxy `nuviosports.xyz` to internal port `7000`.
2. **Clone & Build the Repository**:
   `git clone https://github.com/rajhodedara/live-sport-plugin.git` into `/root/nuvio-live-sports`.
   Run `npm install && npm run build`.
3. **Configure Production `.env`**:
   Set `PORT=7000`, `BASE_URL=https://nuviosports.xyz`, and assign Cloudflare worker URL.
4. **Launch with PM2**:
   Start the app across multiple CPU cores in cluster mode:
   `pm2 start dist/index.js -i 3 --name "nuvio-sports" --max-memory-restart 1000M`
   `pm2 save && pm2 startup`
5. **Verify Public Stremio Manifest**:
   Access `https://nuviosports.xyz/manifest.json` in any browser or Stremio client.
