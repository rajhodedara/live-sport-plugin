#!/usr/bin/env node
/**
 * scripts/regress-ak47-live.js — live A/B regression for AK47 streams.
 *
 * Compares the hosted deployment (old commit) against a local build (current
 * working tree) on *live* matches, and proves playability instead of just
 * "the playlist returned 200":
 *
 *   1. discovers live metas that actually carry AK47 streams on the hosted box
 *   2. pairs the AK47 streams from both sides by title
 *   3. walks master -> media playlist -> init -> first segment
 *   4. concatenates init+segment and runs it through ffmpeg
 *      (a clean decode is the only honest "this would play" signal)
 *
 * Usage:
 *   node scripts/regress-ak47-live.js [--local http://127.0.0.1:7000]
 *                                     [--live https://nuviosports.xyz]
 *                                     [--matches 6] [--segments 1]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LOCAL = arg('local', 'http://127.0.0.1:7000');
const LIVE = arg('live', 'https://nuviosports.xyz');
const MAX_MATCHES = Number(arg('matches', 6));
const SEGMENTS = Number(arg('segments', 1));
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const TIMEOUT = 20000;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ak47-regress-'));

/* ─────────────────────────────── helpers ───────────────────────────────── */

async function get(url, timeout = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36' }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, buf, url: res.url, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, buf: Buffer.alloc(0), url, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url) {
  const res = await get(url);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.buf.toString('utf8'));
  } catch (_) {
    return null;
  }
}

const text = (res) => res.buf.toString('utf8');

/** Resolves a possibly-relative playlist URI against the playlist URL. */
function absolute(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch (_) {
    return uri;
  }
}

function parseAttributes(line) {
  const out = {};
  const body = line.slice(line.indexOf(':') + 1);
  let depth = 0;
  let quote = false;
  let current = '';
  const parts = [];
  for (const ch of body) {
    if (ch === '"') quote = !quote;
    if (ch === ',' && !quote) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  void depth;
  return out;
}

function classifyUrl(url) {
  if (/\/api\/dash\/index\.m3u8/i.test(url)) return 'ak47-dash';
  if (/\/api\/dash\//i.test(url)) return 'ak47-dash';
  if (/\/api\/manifest\.m3u8/i.test(url)) return 'ak47-hls';
  if (/\.mpd(\?|$)/i.test(url)) return 'dash-direct';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  return 'other';
}

/** Minimal decoder probe: does ffmpeg accept the bytes without complaining? */
function ffmpegCheck(buffers) {
  const file = path.join(tmpDir, `probe-${Math.random().toString(16).slice(2)}.mp4`);
  fs.writeFileSync(file, Buffer.concat(buffers));
  try {
    const out = execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 25000
    });
    const err = out.toString().trim();
    return err ? { ok: false, detail: err.split('\n')[0].slice(0, 110) } : { ok: true, detail: 'clean' };
  } catch (err) {
    const stderr = (err.stderr || Buffer.alloc(0)).toString().trim();
    const line = (stderr || err.message || '').split('\n').filter(Boolean)[0] || 'ffmpeg failed';
    return { ok: false, detail: line.slice(0, 110) };
  } finally {
    fs.rm(file, { force: true }, () => {});
  }
}

/* ─────────────────────────── stream probing ────────────────────────────── */

/**
 * @returns {Promise<object>} a flat probe result:
 *   { kind, status, variant, keyLine, initOk, segOk, segBytes, decryptOk, decodeOk, note }
 */
async function probe(streamUrl) {
  const result = {
    kind: classifyUrl(streamUrl),
    status: 0,
    variant: '',
    keyLine: '',
    initOk: null,
    segOk: null,
    segBytes: 0,
    looksEncrypted: null,
    decodeOk: null,
    decodeDetail: '',
    note: ''
  };

  const master = await get(streamUrl);
  result.status = master.status;
  if (!master.ok || master.buf.length === 0) {
    result.note = master.error || `HTTP ${master.status}`;
    return result;
  }

  let playlistUrl = streamUrl;
  let playlist = text(master);

  // Master -> media playlist
  if (playlist.includes('#EXT-X-STREAM-INF')) {
    const lines = playlist.split('\n').map((l) => l.trim());
    const idx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const uriLine = lines.slice(idx + 1).find((l) => l && !l.startsWith('#'));
    if (!uriLine) { result.note = 'master without variant URI'; return result; }
    playlistUrl = absolute(uriLine, streamUrl);
    result.variant = playlistUrl.replace(/^https?:\/\/[^/]+/, '').slice(0, 60);
    const media = await get(playlistUrl);
    if (!media.ok) { result.note = `variant HTTP ${media.status}`; result.status = media.status; return result; }
    playlist = text(media);
  }

  const lines = playlist.split('\n').map((l) => l.trim());
  const keyLineRaw = lines.find((l) => l.startsWith('#EXT-X-KEY'));
  if (keyLineRaw) {
    const attrs = parseAttributes(keyLineRaw);
    result.keyLine = `METHOD=${attrs.METHOD || '?'}${attrs.KEYFORMAT ? `,KEYFORMAT=${attrs.KEYFORMAT}` : ''}`;
  }

  const mapLine = lines.find((l) => l.startsWith('#EXT-X-MAP'));
  const segLines = lines.filter((l) => l && !l.startsWith('#'));
  if (segLines.length === 0) { result.note = 'media playlist has no segments'; return result; }

  let initBuf = null;
  if (mapLine) {
    const mapUrl = absolute(parseAttributes(mapLine).URI, playlistUrl);
    const init = await get(mapUrl);
    result.initOk = init.ok && init.buf.length > 8;
    if (result.initOk) initBuf = init.buf;
  }

  const picked = [];
  for (const raw of segLines.slice(0, Math.max(1, SEGMENTS))) {
    const segUrl = absolute(raw, playlistUrl);
    const seg = await get(segUrl, 30000);
    if (!seg.ok || seg.buf.length < 64) {
      result.segOk = false;
      result.note = result.note || `segment HTTP ${seg.status}`;
      continue;
    }
    picked.push(seg.buf);
    result.segBytes += seg.buf.length;
  }
  result.segOk = picked.length > 0;

  if (picked.length > 0) {
    // If the bytes still carry CENC metadata, a normal HLS player will refuse
    // them — that is the "hosted" failure signature, no player required.
    const head = Buffer.concat([initBuf || Buffer.alloc(0), picked[0]]);
    result.looksEncrypted = head.includes(Buffer.from('encv', 'latin1')) ||
      head.includes(Buffer.from('senc', 'latin1'));

    const probeBuffers = (initBuf ? [initBuf] : []).concat(picked);
    const decoded = ffmpegCheck(probeBuffers);
    result.decodeOk = decoded.ok;
    result.decodeDetail = decoded.detail;
  }

  return result;
}

/* ──────────────────────────── orchestration ────────────────────────────── */

function providerOf(stream) {
  return `${stream.name || ''} ${stream.title || ''}`;
}

function ak47Streams(streams) {
  return (streams || []).filter((s) => /ak47/i.test(providerOf(s)) && s.url);
}

function pairKey(stream) {
  // Titles carry the channel label in parens, e.g. "Match (BEIN1 FHD)".
  const m = String(stream.title || '').match(/\(([^)]+)\)\s*$/);
  return (m ? m[1] : String(stream.title || stream.name || '')).trim().toLowerCase();
}

function fmt(probeResult) {
  if (!probeResult) return '  —                     ';
  const bits = [];
  bits.push(probeResult.status ? `HTTP ${probeResult.status}` : 'no-response');
  if (probeResult.kind) bits.push(probeResult.kind);
  if (probeResult.keyLine) bits.push(probeResult.keyLine);
  if (probeResult.segOk === true) bits.push(`${(probeResult.segBytes / 1024).toFixed(0)}KB`);
  if (probeResult.segOk === false) bits.push('no-segment');
  if (probeResult.looksEncrypted === true) bits.push('CENC-bytes');
  if (probeResult.decodeOk === true) bits.push('DECODES');
  if (probeResult.decodeOk === false) bits.push(`decode-fail: ${probeResult.decodeDetail}`);
  if (probeResult.note) bits.push(probeResult.note);
  return bits.join(' | ');
}

async function run() {
  console.log(`hosted : ${LIVE}`);
  console.log(`local  : ${LOCAL}`);
  console.log(`ffmpeg : ${FFMPEG}\n`);

  const [liveCat, localCat] = await Promise.all([
    getJson(`${LIVE}/catalog/tv/nuvio_sports_live.json`),
    getJson(`${LOCAL}/catalog/tv/nuvio_sports_live.json`)
  ]);

  if (!liveCat) { console.error('cannot read the hosted catalogue'); process.exit(2); }
  if (!localCat) { console.error(`cannot read the local catalogue at ${LOCAL} — is the server up?`); process.exit(2); }

  const localIds = new Set((localCat.metas || []).map((m) => m.id));
  const metas = (liveCat.metas || []).filter((m) => localIds.has(m.id));
  console.log(`live metas: hosted ${(liveCat.metas || []).length}, local ${(localCat.metas || []).length}, common ${metas.length}\n`);

  const rows = [];
  let scanned = 0;

  for (const meta of metas) {
    if (rows.length >= MAX_MATCHES) break;
    scanned += 1;

    const id = encodeURIComponent(meta.id);
    const [liveStreams, localStreams] = await Promise.all([
      getJson(`${LIVE}/stream/tv/${id}.json`),
      getJson(`${LOCAL}/stream/tv/${id}.json`)
    ]);

    const liveAk = ak47Streams(liveStreams && liveStreams.streams);
    const localAk = ak47Streams(localStreams && localStreams.streams);
    if (liveAk.length === 0 && localAk.length === 0) continue;

    console.log(`── ${String(meta.name || meta.id).replace(/^🔴 LIVE:\s*/, '').slice(0, 70)}`);
    console.log(`   offered: hosted ${liveAk.length} AK47, local ${localAk.length} AK47`);

    const byKey = new Map();
    for (const s of liveAk) byKey.set(pairKey(s), { live: s });
    for (const s of localAk) {
      const k = pairKey(s);
      byKey.set(k, { ...(byKey.get(k) || {}), local: s });
    }

    for (const [key, pair] of byKey) {
      const liveProbe = pair.live ? await probe(pair.live.url) : null;
      const localProbe = pair.local ? await probe(pair.local.url) : null;

      console.log(`   • ${key.slice(0, 28).padEnd(29)}`);
      console.log(`       hosted: ${fmt(liveProbe)}`);
      console.log(`       local : ${fmt(localProbe)}`);

      rows.push({ match: meta.name, key, liveProbe, localProbe });
    }
    console.log('');
  }

  console.log(`scanned ${scanned} metas, ${rows.length} AK47 stream pairs\n`);
  console.log('='.repeat(78));
  console.log('SUMMARY');
  console.log('='.repeat(78));

  const tally = (side, field, value) =>
    rows.filter((r) => r[side] && r[side][field] === value).length;

  console.log(`streams paired            : ${rows.length}`);
  console.log(`hosted decodes cleanly    : ${tally('liveProbe', 'decodeOk', true)} / ${rows.length}`);
  console.log(`local  decodes cleanly    : ${tally('localProbe', 'decodeOk', true)} / ${rows.length}`);
  console.log(`hosted served CENC bytes  : ${tally('liveProbe', 'looksEncrypted', true)}`);
  console.log(`local  served CENC bytes  : ${tally('localProbe', 'looksEncrypted', true)}`);
  console.log(`hosted with #EXT-X-KEY    : ${rows.filter((r) => r.liveProbe && r.liveProbe.keyLine).length}`);
  console.log(`local  with #EXT-X-KEY    : ${rows.filter((r) => r.localProbe && r.localProbe.keyLine).length}`);

  console.log('\nREGRESSIONS (local worse than hosted):');
  const regressions = rows.filter((r) =>
    r.liveProbe && r.liveProbe.decodeOk === true && r.localProbe && r.localProbe.decodeOk !== true);
  if (regressions.length === 0) console.log('  none');
  else regressions.forEach((r) => console.log(`  ${r.key}: hosted ${fmt(r.liveProbe)} → local ${fmt(r.localProbe)}`));

  console.log('\nFIXED (hosted broken, local decodes):');
  const fixed = rows.filter((r) =>
    r.localProbe && r.localProbe.decodeOk === true && (!r.liveProbe || r.liveProbe.decodeOk !== true));
  if (fixed.length === 0) console.log('  none');
  else fixed.forEach((r) => console.log(`  ${r.key}: hosted ${fmt(r.liveProbe)} → local DECODES`));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(regressions.length > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('fatal:', err);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(2);
});
