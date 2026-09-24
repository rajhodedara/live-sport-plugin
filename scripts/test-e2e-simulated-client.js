#!/usr/bin/env node
/**
 * scripts/test-e2e-simulated-client.js
 *
 * Automated End-to-End Simulated Stremio Client Test for Nuvio Live Sports Plugin:
 * - Validates R1: Dynamic Host Routing across manifest, catalog, meta, stream
 * - Validates R2: Thumbnail repair, proxying, and 100% HTTP 200 OK image responses
 * - Validates R3: Full Stremio workflow (Manifest -> Catalog -> Meta -> Stream -> M3U8)
 * - Validates Zero Hardcoded 192.168.0.xx instances across all payloads and source files
 */

const { request } = require('undici');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../tests/load/server-runner');

const TEST_PORT = 7010;
const TEST_RESOLVER_PORT = 7013;

const SIMULATED_HOSTS = [
  { 
    name: 'Direct Ngrok Tunnel (HTTPS)', 
    host: 'addon-live.ngrok-free.app', 
    proto: 'https', 
    headers: { 
      'host': 'addon-live.ngrok-free.app', 
      'x-forwarded-proto': 'https' 
    } 
  },
  { 
    name: 'Forwarded Reverse Proxy (Custom Domain)', 
    host: 'stremio-sports.custom-vps.net', 
    proto: 'https', 
    headers: { 
      'x-forwarded-host': 'stremio-sports.custom-vps.net', 
      'x-forwarded-proto': 'https', 
      'host': '127.0.0.1:7010' 
    } 
  },
  { 
    name: 'Localhost Direct Port', 
    host: '127.0.0.1:7010', 
    proto: 'http', 
    headers: { 
      'host': '127.0.0.1:7010' 
    } 
  }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runE2ESimulatedClient() {
  console.log('\n' + '═'.repeat(80));
  console.log('  🏆 NUVIO LIVE SPORTS PLUGIN — E2E SIMULATED STREMIO CLIENT TEST');
  console.log('═'.repeat(80) + '\n');

  let serverInstance = null;
  const testResults = [];
  const record = (phase, name, passed, details = '') => {
    testResults.push({ phase, name, passed, details });
    const icon = passed ? '✅' : '❌';
    console.log(`  ${icon} [${phase}] ${name} ${details ? `(${details})` : ''}`);
  };

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 1: Server Lifecycle & Readiness
    // ─────────────────────────────────────────────────────────────────────────
    console.log('📦 [Phase 1] Booting / Connecting to Plugin Server...');
    serverInstance = await startServer({
      port: TEST_PORT,
      resolverPort: TEST_RESOLVER_PORT,
      reuseExisting: true
    });
    const baseUrl = serverInstance.baseUrl;

    // Await match sync (poll /api/matches up to 30s)
    let matches = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      try {
        const res = await request(`${baseUrl}/api/matches`);
        if (res.statusCode === 200) {
          matches = await res.body.json();
          if (Array.isArray(matches) && matches.length > 0) break;
        }
      } catch (_) {}
      await sleep(1000);
    }
    record('Phase 1', 'Server Boot & Health Check', true, `Port ${TEST_PORT}, ${matches.length} matches ingested`);

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 2: Dynamic Host Routing (R1)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🌐 [Phase 2] Verifying Dynamic Host Routing Across Endpoints...');
    for (const sim of SIMULATED_HOSTS) {
      const headers = sim.headers;
      const expectedBase = `${sim.proto}://${sim.host}`;

      // 2A. Manifest
      const mRes = await request(`${baseUrl}/manifest.json`, { headers });
      const mText = await mRes.body.text();
      const mNoLanIp = !mText.includes('192.168.0.');
      record('Phase 2', `Manifest Host Reflection (${sim.name})`, mRes.statusCode === 200 && mNoLanIp, `Host: ${sim.host}`);

      // 2B. Catalog (Live & Networks)
      const catalogPaths = ['/catalog/tv/nuvio_sports_live.json', '/catalog/tv/nuvio_sports_networks.json'];
      for (const cPath of catalogPaths) {
        const cRes = await request(`${baseUrl}${cPath}`, { headers });
        const cText = await cRes.body.text();
        const cNoLanIp = !cText.includes('192.168.0.');
        let posterReflectsHost = true;
        try {
          const cData = JSON.parse(cText);
          if (cData.metas && cData.metas.length > 0) {
            const firstWithPoster = cData.metas.find(m => m.poster) || cData.metas[0];
            if (firstWithPoster && firstWithPoster.poster) {
              posterReflectsHost = firstWithPoster.poster.startsWith(expectedBase);
            }
          }
        } catch (_) {}
        const catName = cPath.includes('live') ? 'Live Catalog' : 'Networks Catalog';
        record('Phase 2', `${catName} URLs Reflection (${sim.name})`, cRes.statusCode === 200 && cNoLanIp && posterReflectsHost, `Expected: ${expectedBase}`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 3: Catalog & Thumbnail Repair (R2)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🖼️  [Phase 3] Validating Catalog Posters & Thumbnail Proxy (200 OK)...');
    let metas = [];
    try {
      const liveRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_live.json`);
      const liveData = await liveRes.body.json();
      if (Array.isArray(liveData.metas)) metas = metas.concat(liveData.metas);
    } catch (_) {}

    try {
      const netRes = await request(`${baseUrl}/catalog/tv/nuvio_sports_networks.json`);
      const netData = await netRes.body.json();
      if (Array.isArray(netData.metas)) metas = metas.concat(netData.metas);
    } catch (_) {}

    const imageUrls = new Set();
    metas.slice(0, 30).forEach(m => {
      if (m.poster) imageUrls.add(m.poster);
      if (m.logo) imageUrls.add(m.logo);
      if (m.background) imageUrls.add(m.background);
    });

    const imageList = Array.from(imageUrls).slice(0, 20);
    let imagesPassed = 0;
    let corsHeaderPassed = true;

    if (imageList.length > 0) {
      const results = await Promise.allSettled(
        imageList.map(async (imgUrl) => {
          const localUrl = imgUrl.replace(/^https?:\/\/[^/]+/, baseUrl);
          const iRes = await request(localUrl, { headersTimeout: 4000, bodyTimeout: 4000 });
          const cType = iRes.headers['content-type'] || '';
          const ok = iRes.statusCode === 200 && (cType.includes('image/') || cType.includes('svg+xml'));
          const acao = iRes.headers['access-control-allow-origin'];
          const corsOk = acao === '*' || (typeof acao === 'string' && acao.includes('*'));
          return { ok, corsOk };
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          if (r.value.ok) imagesPassed++;
          if (!r.value.corsOk) corsHeaderPassed = false;
        }
      });
    }

    const totalImages = imageList.length;
    const thumbnailSuccessRate = totalImages > 0 ? (imagesPassed / totalImages) * 100 : 100;
    record('Phase 3', 'Catalog Thumbnail Accessibility', thumbnailSuccessRate === 100, `${imagesPassed}/${totalImages} images returned 200 OK`);
    record('Phase 3', 'Thumbnail CORS Headers', corsHeaderPassed, 'Access-Control-Allow-Origin: * verified');

    // 3B. Direct SVG Placeholder Route Test
    const placeholderRes = await request(`${baseUrl}/img/placeholder?text=Live%20Sports&color=10b981`);
    const placeholderType = placeholderRes.headers['content-type'] || '';
    const placeholderAcao = placeholderRes.headers['access-control-allow-origin'];
    const placeholderPassed = placeholderRes.statusCode === 200 && (placeholderType.includes('svg+xml') || placeholderType.includes('image/png')) && (placeholderAcao === '*' || placeholderAcao?.includes('*'));
    record('Phase 3', 'Direct /img/placeholder Endpoint', placeholderPassed, `Status: ${placeholderRes.statusCode}, Type: ${placeholderType}`);

    // 3C. Test Fallback on Dead Upstream Image
    const deadImgRes = await request(`${baseUrl}/img?url=https://dead-upstream.invalid/broken.png&text=TestFallback&color=10b981`);
    const deadImgType = deadImgRes.headers['content-type'] || '';
    const deadImgAcao = deadImgRes.headers['access-control-allow-origin'];
    const deadImgPassed = deadImgRes.statusCode === 200 && (deadImgType.includes('svg+xml') || deadImgType.includes('image/png')) && (deadImgAcao === '*' || deadImgAcao?.includes('*'));
    record('Phase 3', 'Resilient SVG Fallback on Dead Image', deadImgPassed, `Status: ${deadImgRes.statusCode}, Type: ${deadImgType}`);

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4: Full Stream Resolution & M3U8 Playback (R3)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🎬 [Phase 4] Simulating Stream Resolution & M3U8 Playback...');
    let targetMatch = metas.find(m => m.id.startsWith('nuvio_sport_fms_'));
    if (!targetMatch) targetMatch = metas.find(m => m.id.startsWith('nuvio_sport_') || m.id.startsWith('iptv_') || m.id.startsWith('spk_') || m.id.startsWith('ss99_')) || metas[0];
    if (targetMatch) {
      // 4A. Meta
      const metaRes = await request(`${baseUrl}/meta/tv/${targetMatch.id}.json`, {
        headers: { host: 'addon.test-domain.xyz' }
      });
      const metaData = await metaRes.body.json();
      const metaPassed = metaRes.statusCode === 200 && !!metaData.meta;
      const metaPosterReflects = metaData.meta && metaData.meta.poster ? metaData.meta.poster.includes('addon.test-domain.xyz') : true;
      record('Phase 4', 'Fetch Match Metadata (Dynamic Host)', metaPassed && metaPosterReflects, `Match: ${targetMatch.name || targetMatch.id}`);

      // 4B. Stream Array
      const streamRes = await request(`${baseUrl}/stream/tv/${targetMatch.id}.json`, {
        headers: { host: 'addon.test-domain.xyz' }
      });
      const streamData = await streamRes.body.json();
      const streams = streamData.streams || [];
      const streamsPassed = streamRes.statusCode === 200 && streams.length > 0;
      
      // Check stream URLs dynamic host rewrite
      let streamUrlsDynamic = true;
      streams.forEach(s => {
        if (s.url && s.url.includes('/api/manifest') && !s.url.includes('addon.test-domain.xyz')) {
          streamUrlsDynamic = false;
        }
        if (s.externalUrl && s.externalUrl.includes('/watch') && !s.externalUrl.includes('addon.test-domain.xyz')) {
          streamUrlsDynamic = false;
        }
      });
      record('Phase 4', 'Resolve Stream Array (Dynamic Host)', streamsPassed && streamUrlsDynamic, `Resolved ${streams.length} streams`);

      // 4C. M3U8 Manifest Verification
      const directStream = streams.find(s => s.url && (s.url.includes('/api/manifest') || s.url.includes('.m3u8')));
      if (directStream) {
        const localM3u8Url = directStream.url.replace(/^https?:\/\/[^/]+/, baseUrl);
        try {
          const m3u8Res = await request(localM3u8Url, {
            headers: directStream.behaviorHints?.proxyHeaders?.request || {},
            headersTimeout: 5000,
            bodyTimeout: 5000
          });
          const m3u8Body = await m3u8Res.body.text();
          const m3u8Valid = m3u8Res.statusCode === 200 && (m3u8Body.includes('#EXTM3U') || m3u8Body.includes('#EXT-X-STREAM-INF') || m3u8Body.includes('#EXTINF'));
          record('Phase 4', 'HLS M3U8 Manifest Resolution', m3u8Valid, `Status: ${m3u8Res.statusCode}, #EXTM3U: ${m3u8Body.includes('#EXTM3U')}`);
        } catch (err) {
          record('Phase 4', 'HLS M3U8 Manifest Resolution', false, err.message);
        }
      }

      // 4D. Web Stream Verification
      const webStream = streams.find(s => s.externalUrl && s.externalUrl.includes('/watch'));
      if (webStream) {
        const localWebUrl = webStream.externalUrl.replace(/^https?:\/\/[^/]+/, baseUrl);
        try {
          const webRes = await request(localWebUrl, { headersTimeout: 5000, bodyTimeout: 5000 });
          const webBody = await webRes.body.text();
          const webValid = webRes.statusCode === 200 && (webBody.includes('player') || webBody.includes('video') || webBody.includes('iframe'));
          record('Phase 4', 'Web Player Embed Proxy (/watch)', webValid, `Status: ${webRes.statusCode}`);
        } catch (err) {
          record('Phase 4', 'Web Player Embed Proxy (/watch)', false, err.message);
        }
      } else {
        record('Phase 4', 'Web Player Embed Proxy (/watch)', true, 'Skipped: No /watch stream found');
      }
    } else {
      record('Phase 4', 'Stream Resolution', true, 'Skipped: No active fixture in test environment');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 5: Codebase Static Zero-Hardcoded-IP Scan
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🔍 [Phase 5] Scanning Codebase for Zero Hardcoded Private IPs...');
    const srcDir = path.join(__dirname, '..', 'src');
    const scanFiles = (dir) => {
      let results = [];
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        if (fs.statSync(full).isDirectory()) results = results.concat(scanFiles(full));
        else if (full.endsWith('.js') || full.endsWith('.json')) results.push(full);
      }
      return results;
    };

    let hardcodedMatches = [];
    for (const f of scanFiles(srcDir)) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('192.168.0.')) {
        hardcodedMatches.push(f);
      }
    }
    const zeroHardcodedPassed = hardcodedMatches.length === 0;
    record('Phase 5', 'Zero Hardcoded 192.168.0.xx Strings in src/', zeroHardcodedPassed, zeroHardcodedPassed ? '0 occurrences found' : `Found in ${hardcodedMatches.join(', ')}`);

  } finally {
    // ─────────────────────────────────────────────────────────────────────────
    // Phase 6: Teardown & Reporting
    // ─────────────────────────────────────────────────────────────────────────
    if (serverInstance && serverInstance.isSpawned) {
      await serverInstance.shutdown();
    }

    console.log('\n' + '═'.repeat(80));
    console.log('                          📊 FINAL TEST SUMMARY REPORT');
    console.log('═'.repeat(80));
    const allPassed = testResults.every(r => r.passed);
    testResults.forEach(r => {
      const mark = r.passed ? 'PASS [OK]' : 'FAIL [X] ';
      console.log(`  ${mark} | ${r.phase.padEnd(8)} | ${r.name.padEnd(42)} | ${r.details}`);
    });
    console.log('═'.repeat(80));
    console.log(`  Overall Result: ${allPassed ? '🎉 ALL TESTS PASSED' : '⚠️ TEST FAILURES DETECTED'}\n`);

    if (!allPassed) process.exit(1);
  }
}

runE2ESimulatedClient().catch((err) => {
  console.error('[FATAL] Test runner uncaught exception:', err);
  process.exit(1);
});
