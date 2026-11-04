#!/usr/bin/env node
/**
 * scripts/leaf-health.mjs - does Leaf actually serve media right now?
 *
 * Tests the production request path (impitClient, which honours WARP_PROXY_URL / LEAF_PROXY_URL)
 * rather than a bare fetch, because that is the only path whose egress matters.
 *
 * A healthy Leaf answers with a real playlist:
 *   - 8-ish segment lines pointing at w1.papacito.cfd/leaf/<slug>/<session>/seg_N.ts?a=<hash>
 * An unhealthy Leaf answers 200 with a well-formed playlist whose segments point at:
 *   - w1.papacito.cfd/leaf/stream_notice/... (papacito's honeypot reel)
 *
 * Exit codes: 0 healthy, 1 unhealthy, 2 misconfigured.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readEnv() {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; })
  );
}

const env = { ...readEnv(), ...process.env };
Object.assign(process.env, env);
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const idArg = (() => { const i = args.indexOf('--id'); return i >= 0 ? args[i + 1] : null; })();

const { normalizeConfigBlob } = require('../src/services/LeafMint');
const impitClient = require('../src/impitClient');

const raw = env.LEAF_INSTALL_CONFIG || env.LEAF_FREE_USER_ID || '';
const origin = (env.LEAF_API_ORIGIN || 'https://sports.highfly.to').replace(/\/+$/, '');
const override = env.LEAF_API_URL || '';

if (!raw && !override) {
  console.error('leaf-health: no LEAF_INSTALL_CONFIG / LEAF_FREE_USER_ID and no LEAF_API_URL');
  process.exit(2);
}

const configSegment = normalizeConfigBlob(raw);
const base = override
  ? override.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '')
  : `${origin}/${configSegment}`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const jwtClaim = (url) => {
  try {
    const ft = new URL(url).searchParams.get('ft');
    return JSON.parse(Buffer.from(ft.split('.')[1], 'base64url').toString());
  } catch { return null; }
};

const result = {
  ok: false,
  base: base.replace(/^https:\/\//, 'https://').slice(0, 50) + '…',
  warpConfigured: Boolean(env.WARP_PROXY_URL || env.DAMITV_PROXY_URL),
  leafProxy: env.LEAF_PROXY_URL || env.WARP_PROXY_URL || null,
  catalogStatus: null,
  matches: null,
  probeId: idArg,
  streamEntries: null,
  papacitoUrls: null,
  claim: null,
  playlist: null,
  segment: null,
  verdict: null,
};

// 1. catalogue
try {
  const res = await impitClient.safeFetch(`${base}/catalog/sport/sports_live.json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: 12000,
  });
  result.catalogStatus = res && res.status;
  if (res && res.ok) {
    const body = await res.json();
    const metas = Array.isArray(body.metas) ? body.metas : [];
    result.matches = metas.filter((m) => !String(m.id).startsWith('leaf:')).length;
    result.channels = metas.length - result.matches;
    if (!result.probeId) {
      const firstLive = metas.find((m) => !String(m.id).startsWith('leaf:') && m.status !== 'upcoming');
      if (firstLive) result.probeId = firstLive.id;
    }
  }
} catch (e) {
  result.catalogError = e.message;
}

// 2. stream
if (result.probeId) {
  try {
    const sres = await impitClient.safeFetch(`${base}/stream/sport/${encodeURIComponent(result.probeId)}.json`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: 12000,
    });
    if (sres && sres.ok) {
      const sbody = await sres.json();
      const streams = Array.isArray(sbody.streams) ? sbody.streams : [];
      result.streamEntries = streams.length;
      const papacito = streams.filter((s) => s && typeof s.url === 'string' && s.url.includes('papacito.cfd'));
      result.papacitoUrls = papacito.length;
      if (papacito[0]) {
        result.claim = jwtClaim(papacito[0].url);

        // 3. playlist
        const pres = await impitClient.safeFetch(papacito[0].url, {
          headers: {
            'User-Agent': UA,
            'Referer': 'https://sports.highfly.to/',
            'Origin': 'https://sports.highfly.to',
            Accept: '*/*',
          },
          timeoutMs: 10000,
        });
        if (pres && pres.ok) {
          const text = await pres.text();
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
          const segLines = lines.filter((l) => !l.startsWith('#') && l.includes('.ts'));
          const isNotice = text.includes('stream_notice') || text.includes('_antipiracy');
          result.playlist = {
            status: pres.status,
            bytes: text.length,
            segments: segLines.length,
            notice: isNotice,
            first: segLines[0] || null,
          };

          // 4. segment probe (HEAD request directly to CDN)
          if (segLines[0]) {
            try {
              const segRes = await impitClient.safeFetch(segLines[0], {
                method: 'HEAD',
                headers: { 'User-Agent': UA, Accept: '*/*' },
                timeoutMs: 10000,
              });
              result.segment = { status: segRes && segRes.status };
            } catch (se) {
              result.segment = { error: se.message };
            }
          }

          if (isNotice) {
            result.verdict = 'HONEYPOT: upstream returned stream_notice fake playlist (egress IP flagged or burned identity)';
          } else if (segLines.length > 0) {
            result.ok = true;
            result.verdict = 'OK: real playlist with signed CDN segments';
          } else {
            result.verdict = 'EMPTY: playlist has no media segments';
          }
        } else {
          result.playlist = { status: pres ? pres.status : null };
          result.verdict = `FAIL: playlist fetch returned ${pres ? pres.status : 'no response'}`;
        }
      } else {
        result.verdict = 'FAIL: stream JSON has no papacito URLs';
      }
    } else {
      result.verdict = `FAIL: stream fetch returned ${sres ? sres.status : 'no response'}`;
    }
  } catch (e) {
    result.streamError = e.message;
    result.verdict = `FAIL: ${e.message}`;
  }
} else {
  result.verdict = 'NO_FIXTURES: catalogue has no active live sports fixtures right now';
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[Leaf Health Report]`);
  console.log(`Base URL:        ${result.base}`);
  console.log(`Leaf Proxy:      ${result.leafProxy || 'NONE (direct egress)'}`);
  console.log(`Catalog Status:  ${result.catalogStatus || 'FAIL'} (${result.matches ?? 0} matches, ${result.channels ?? 0} channels)`);
  console.log(`Probe Match:     ${result.probeId || 'none'}`);
  console.log(`Papacito Streams:${result.papacitoUrls ?? 0} / ${result.streamEntries ?? 0}`);
  if (result.claim) {
    console.log(`Minted For IP:   ${result.claim.ip} (uid: ${result.claim.uid})`);
  }
  if (result.playlist) {
    console.log(`Playlist:        ${result.playlist.status} (${result.playlist.bytes} bytes, ${result.playlist.segments} segs, notice: ${result.playlist.notice})`);
  }
  if (result.segment) {
    console.log(`Segment Check:   HTTP ${result.segment.status || result.segment.error}`);
  }
  console.log(`Verdict:         ${result.verdict}`);
}

process.exit(result.ok ? 0 : 1);
