#!/usr/bin/env node
/**
 * Leaf metadata diagnostic through the provider's guarded outbound path.
 * Catalog, stream, playlist and one segment HEAD are checked; player playback
 * and segment contents are not tested. No signed URLs or identities are logged.
 * Exit codes: 0 metadata reachable, 1 unavailable, 2 misconfigured.
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
const { safeFetch } = require('../src/services/ProviderOutbound');
const { runLeafDiagnostics } = require('../src/services/LeafDiagnostics');

const raw = env.LEAF_INSTALL_CONFIG || env.LEAF_FREE_USER_ID || '';
const origin = (env.LEAF_API_ORIGIN || 'https://sports.highfly.to').replace(/\/+$/, '');
const override = env.LEAF_API_URL || '';

if (!raw && !override) {
  console.error('ERR_LEAF_DIAGNOSTIC_UNCONFIGURED');
  process.exit(2);
}

const configSegment = normalizeConfigBlob(raw);
const base = override
  ? override.replace(/\/manifest\.json$/i, '').replace(/\/+$/, '')
  : `${origin}/${configSegment}`;

const result = await runLeafDiagnostics({
  base, probeId: idArg, safeFetch,
  config: {
    installConfigured: Boolean(raw),
    apiOverrideConfigured: Boolean(override),
    leafProxyEnvPresent: Boolean(env.LEAF_PROXY_URL),
    warpProxyEnvPresent: Boolean(env.WARP_PROXY_URL),
    damiProxyEnvPresent: Boolean(env.DAMITV_PROXY_URL)
  }
});

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('[Leaf Metadata Report — playback NOT_RUN]');
  console.log(`API Origin:      ${result.apiOrigin || 'unavailable'}`);
  console.log(`Config Present:  install=${result.config.installConfigured}, override=${result.config.apiOverrideConfigured}, leafProxy=${result.config.leafProxyEnvPresent}, warp=${result.config.warpProxyEnvPresent}, damiProxy=${result.config.damiProxyEnvPresent}`);
  console.log(`Catalog Status:  ${result.catalogStatus ?? 'unavailable'} (${result.matches ?? 0} matches, ${result.channels ?? 0} channels)`);
  console.log(`Probe Selected:  ${result.probeSelected}`);
  console.log(`Media Streams:   ${result.papacitoUrls ?? 0} / ${result.streamEntries ?? 0}`);
  console.log(`Token Expiry:    ${result.unverifiedTokenExpiry ?? 'unavailable'} (unverified claim)`);
  if (result.catalogError) console.log(`Catalog Error:   ${result.catalogError}`);
  if (result.streamError) console.log(`Request Error:   ${result.streamError}`);
  if (result.playlist) console.log(`Playlist:        ${result.playlist.status ?? 'unavailable'} (${result.playlist.bytes ?? 0} bytes, ${result.playlist.segments ?? 0} segments, notice=${result.playlist.notice ?? false})`);
  if (result.segment) console.log(`Segment HEAD:    ${result.segment.status ?? result.segment.error}`);
  console.log(`Verdict:         ${result.verdict}`);
}

process.exit(result.ok ? 0 : 1);
