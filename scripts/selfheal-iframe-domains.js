#!/usr/bin/env node
'use strict';
/**
 * selfheal-iframe-domains.js
 *
 * Self-healing audit for DaddyLive-family iframe domains.
 *
 * WHAT IT DOES
 *   1. Reads the live DaddyLive schedule and enumerates the channels on air.
 *   2. Follows each channel's player -> iframe -> embed chain and records the
 *      iframe host actually used.
 *   3. For every host NOT already known to the registry, fetches its embed page
 *      and tests whether the EXISTING decoders work on it - specifically:
 *        - decodeEconfig   (the common case; assetrage + dynproclaim both use it)
 *        - EmbedExtractorChain
 *        - direct .m3u8
 *      and reports which strategy succeeded.
 *
 * WHY
 *   DaddyLive rotates embed domains. Rather than noticing in production when a
 *   channel silently stops resolving, this re-discovers the current domain set
 *   and flags anything new plus whether it needs a new decoder.
 *
 * USAGE
 *   node scripts/selfheal-iframe-domains.js               # report only (default)
 *   node scripts/selfheal-iframe-domains.js --limit 60    # sample size
 *   node scripts/selfheal-iframe-domains.js --update      # persist new domains
 *   node scripts/selfheal-iframe-domains.js --json out.json
 *
 * Read-only unless --update is passed.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { safeFetch } = require('../src/impitClient');
const { extract: extractChain } = require('../src/services/EmbedExtractorChain');
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const IframeDomainRegistry = require('../src/services/IframeDomainRegistry');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';
const BASE = 'https://dlstreams.st';
const DATA_FILE = path.join(__dirname, '..', 'src', 'data', 'iframe_domains.json');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  return i >= 0 ? parseInt(argv[i + 1], 10) || 40 : 40;
})();
const UPDATE = argv.includes('--update');
const JSON_OUT = (() => {
  const i = argv.indexOf('--json');
  return i >= 0 ? argv[i + 1] : null;
})();

// Decoder probe copied in spirit from DaddyLiveProvider.decodeEconfig. Instantiated
// from the real class so the script can never drift from production decoding.
const decoder = Object.create(DaddyLiveProvider.prototype);

async function get(url, referer, timeoutMs = 15000) {
  const res = await safeFetch(url, {
    headers: { 'User-Agent': UA, 'Referer': referer, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
    timeoutMs,
    attempts: 1
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
}

function hostOf(u) { try { return new URL(u).hostname; } catch (_) { return null; } }

/** Test the existing decoders against one embed page. */
function probeDecoders(html) {
  // 1. _econfig (the common case)
  const ec = html.match(/_econfig\s*=\s*['"]([^'"]+)['"]/);
  if (ec && ec[1]) {
    const conf = decoder.decodeEconfig(ec[1]);
    if (conf) {
      const u = conf.stream_url || conf.stream_url_nop2p || null;
      if (u) return { strategy: 'econfig', url: u };
    }
  }
  // 2. extractor chain
  const c = extractChain(html, 'daddylive');
  if (c && c.url) return { strategy: 'chain', url: c.url };
  // 3. direct m3u8
  const d = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
  if (d && d[1]) return { strategy: 'direct', url: d[1] };
  return null;
}

(async () => {
  const registry = new IframeDomainRegistry();
  console.log('=== DaddyLive iframe-domain self-heal ===');
  console.log(`registry loaded : ${registry.isLoaded} (${Object.keys(registry.toJSON().families).length} families)`);
  console.log(`sample limit    : ${LIMIT}`);
  console.log(`mode            : ${UPDATE ? 'REPORT + UPDATE' : 'REPORT ONLY'}\n`);

  // ---- 1. live channels -----------------------------------------------------
  const home = await get(BASE + '/', BASE + '/');
  console.log(`schedule        : HTTP ${home.status}, ${home.text.length} bytes`);
  const $ = cheerio.load(home.text);
  const dayHeader = $('.schedule__dayTitle').first().text().trim();
  console.log(`day             : ${dayHeader}`);

  const seen = new Map();
  $('.schedule__event').each((_, ev) => {
    const title = $(ev).find('.schedule__eventTitle').text().trim();
    $(ev).find('.schedule__channels a').each((_, a) => {
      const m = ($(a).attr('href') || '').match(/id=(\d+)/);
      if (m && m[1] !== '00' && !seen.has(m[1])) seen.set(m[1], title);
    });
  });
  const channels = [...seen.entries()].map(([id, title]) => ({ id, title }));
  console.log(`live channels   : ${channels.length}`);
  const sample = channels.slice(0, LIMIT);
  console.log(`sampling        : ${sample.length}\n`);

  // ---- 2. resolve iframe hosts ---------------------------------------------
  const hostStats = new Map();      // host -> { count, channels[] }
  const unknownHosts = new Map();   // host -> { sample, channels[] }
  let playerOk = 0, iframeOk = 0;

  for (let i = 0; i < sample.length; i++) {
    const ch = sample[i];
    const playerUrl = `${BASE}/stream/stream-${ch.id}.php`;
    try {
      const pr = await get(playerUrl, BASE + '/');
      if (!pr.ok) continue;
      playerOk++;
      const im = pr.text.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
      if (!im || !im[1]) continue;
      let iu = im[1];
      if (iu.startsWith('//')) iu = 'https:' + iu;
      else if (iu.startsWith('/')) iu = new URL(iu, playerUrl).toString();
      const host = hostOf(iu);
      if (!host) continue;
      iframeOk++;

      if (!hostStats.has(host)) hostStats.set(host, { count: 0, channels: [] });
      const st = hostStats.get(host);
      st.count++;
      st.channels.push(ch.id);

      if (!registry.has(host) && !registry.isIgnored(host)) {
        if (!unknownHosts.has(host)) unknownHosts.set(host, { sample: iu, channels: [] });
        unknownHosts.get(host).channels.push(ch.id);
      }
      process.stdout.write(`\r  resolving ... ${i + 1}/${sample.length}`);
    } catch (_) {}
  }
  process.stdout.write('\n\n');

  // ---- 3. test unknown hosts against existing decoders ---------------------
  console.log('=== iframe domains in use ===');
  const rows = [...hostStats.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [host, st] of rows) {
    const known = registry.has(host);
    const ignored = registry.isIgnored(host);
    console.log(`  ${known ? 'KNOWN  ' : ignored ? 'NOISE  ' : 'NEW    '} ${String(st.count).padStart(3)}x  ${host}`);
  }

  console.log('\n=== decoder probe for newly-seen domains ===');
  const findings = [];
  for (const [host, info] of unknownHosts) {
    const rec = { host, slug: IframeDomainRegistry.toSlug(host), sample: info.sample, channels: info.channels.length, strategy: null, terminal: null, note: '' };
    try {
      const er = await get(info.sample, `${BASE}/stream/stream-${info.channels[0]}.php`);
      if (!er.ok) { rec.note = `embed HTTP ${er.status}`; }
      else {
        const probe = probeDecoders(er.text);
        if (probe) {
          rec.strategy = probe.strategy;
          rec.terminal = hostOf(probe.url);
          // Confirm the terminal actually serves a playlist.
          try {
            const mr = await safeFetch(probe.url, { headers: { 'User-Agent': UA, 'Referer': info.sample, 'Accept': '*/*' }, timeoutMs: 12000, attempts: 1 });
            const body = await mr.text();
            rec.live = body.includes('#EXTM3U');
            rec.segments = (body.match(/#EXTINF/g) || []).length;
          } catch (e) { rec.note = 'manifest ' + e.message; }
        } else {
          rec.note = 'no existing decoder matched (may need json-hop / nested handling)';
        }
      }
    } catch (e) {
      rec.note = e.message;
    }
    findings.push(rec);
    const verdict = rec.strategy
      ? `SAME DECODER (${rec.strategy})${rec.live ? ' + manifest LIVE' : ''}`
      : `NEW DECODER NEEDED`;
    console.log(`  ${host}`);
    console.log(`      -> ${verdict}${rec.terminal ? ' | terminal: ' + rec.terminal : ''}${rec.note ? ' | ' + rec.note : ''}`);
  }
  if (findings.length === 0) console.log('  (no new domains — registry is current)');

  // ---- 4. report / persist --------------------------------------------------
  const sameDecoder = findings.filter((f) => f.strategy).length;
  console.log('\n=== summary ===');
  console.log(`  sampled channels     : ${sample.length}`);
  console.log(`  player pages OK      : ${playerOk}`);
  console.log(`  iframes found        : ${iframeOk}`);
  console.log(`  distinct iframe hosts: ${hostStats.size}`);
  console.log(`  new domains          : ${findings.length}`);
  console.log(`  reusable decoder     : ${sameDecoder}/${findings.length}`);
  console.log(`  need new decoder     : ${findings.length - sameDecoder}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ day: dayHeader, sampled: sample.length, hosts: rows.map(([h, s]) => ({ host: h, count: s.count })), findings }, null, 2));
    console.log(`  json written         : ${JSON_OUT}`);
  }

  if (UPDATE && findings.length) {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let added = 0;
    for (const f of findings) {
      if (!f.slug || raw.families[f.slug]) continue;
      raw.families[f.slug] = {
        role: f.strategy ? 'embed' : 'unknown',
        strategy: f.strategy || 'unknown',
        referer: `https://${f.host}/`,
        first_seen: new Date().toISOString().slice(0, 10),
        note: f.strategy
          ? `Auto-registered by selfheal; existing ${f.strategy} decoder works.${f.terminal ? ' Terminal: ' + f.terminal + '.' : ''}`
          : `Auto-registered by selfheal; no existing decoder matched. ${f.note || ''}`.trim()
      };
      added++;
    }
    if (added) {
      raw.updated = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2) + '\n');
      console.log(`  registry updated     : +${added} families -> ${path.relative(process.cwd(), DATA_FILE)}`);
    } else {
      console.log('  registry updated     : nothing new to add');
    }
  } else if (findings.length) {
    console.log('  (run with --update to persist these)');
  }
})().catch((e) => { console.error('selfheal failed:', e.message); process.exit(1); });
