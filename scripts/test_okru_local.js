/**
 * Run this on YOUR LOCAL MACHINE (not the VPS).
 * It tests a CDN URL minted on the VPS (different IP) WITH proper headers.
 * 
 * If 206 → srcIp is NOT enforced, just needs Referer + UA
 * If 400/403 → srcIp IS enforced by IP
 */

const https = require('https');
const http = require('http');

// Fresh URL minted on VPS (srcIp=VPS_IP) — replace if expired
const CDN_URL = process.argv[2];

if (!CDN_URL) {
  console.error('Usage: node test_okru_local.js <cdn_url>');
  console.error('Get a fresh URL by running on VPS: node scripts/_probe_okru.js');
  process.exit(1);
}

const u = new URL(CDN_URL);
console.log('srcIp in token:', u.searchParams.get('srcIp'));
console.log('expires:', new Date(parseInt(u.searchParams.get('expires'))).toISOString());

async function testFetch(label, headers) {
  return new Promise((resolve) => {
    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'Range': 'bytes=0-65535', ...headers }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        console.log(`  [${res.statusCode}] ${label} — ${body.length} bytes`);
        if (res.statusCode >= 400) {
          console.log('         Response body:', body.toString().slice(0, 100));
        }
        resolve(res.statusCode);
      });
    });
    req.on('error', (e) => { console.log(`  [ERR] ${label}: ${e.message}`); resolve(0); });
    req.end();
  });
}

async function run() {
  // First: what's our public IP?
  const ipRes = await new Promise((resolve) => {
    http.get('http://api.ipify.org', (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    });
  });
  
  console.log('\nYour public IP:', ipRes);
  console.log('Token srcIp:   ', u.searchParams.get('srcIp'));
  console.log('IPs match?     ', ipRes === u.searchParams.get('srcIp'));
  console.log('\n=== Testing with various headers ===');

  await testFetch('Chrome UA + Referer', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Referer': 'https://ok.ru/',
    'Origin': 'https://ok.ru'
  });

  await testFetch('ExoPlayer UA + Referer', {
    'User-Agent': 'ExoPlayerLib/2.18.5 (Linux; Android 12)',
    'Referer': 'https://ok.ru/'
  });

  await testFetch('No Referer (browser paste simulation)', {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  });

  await testFetch('No headers at all', {});

  console.log('\n=== Conclusion ===');
  console.log('If Chrome+Referer = 206 → srcIp is NOT enforced (just needs Referer)');
  console.log('If Chrome+Referer = 400/403 → srcIp IS enforced by IP');
}

run().catch(console.error);
