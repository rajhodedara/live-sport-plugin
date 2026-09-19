/**
 * Test whether ok.ru CDN actually enforces srcIp or just uses it as a routing hint.
 * 
 * Strategy: scrape a FRESH token right now, immediately try it with:
 *   1. Full browser headers (Referer, Origin, UA)
 *   2. ExoPlayer UA (simulating a TV player from a different IP)
 *   3. No headers at all
 * 
 * If srcIp is truly enforced → all fail with 400/403
 * If srcIp is just a signed field → 206 from any IP with correct Referer
 */

const undici = require('undici');

async function testIpEnforcement() {
  console.log('=== Step 1: Minting fresh ok.ru CDN URL ===');
  const { body } = await undici.request('https://ok.ru/videoembed/15812810246868', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': 'https://ok.ru/'
    }
  });
  const html = await body.text();
  const raw = html.split('data-options=')[1];
  const q = raw[0];
  const json = JSON.parse(raw.slice(1).split(q)[0].replace(/&quot;/g, '"'));
  const meta = typeof json.flashvars.metadata === 'string' ? JSON.parse(json.flashvars.metadata) : json.flashvars.metadata;

  // Get BEST quality available
  const bestVideo = meta.videos[meta.videos.length - 1];
  const cdnUrl = bestVideo.url;
  const u = new URL(cdnUrl);

  console.log('Token minted at:', new Date().toISOString());
  console.log('srcIp in token:', u.searchParams.get('srcIp'));
  console.log('expires:', new Date(parseInt(u.searchParams.get('expires'))).toISOString());
  console.log('sig:', u.searchParams.get('sig'));
  console.log('CDN host:', u.hostname);
  console.log('Full URL:', cdnUrl.slice(0, 120));

  // NOW immediately try from this machine (which may have a different public IP than srcIp)
  const attempts = [
    {
      label: 'Full browser headers (Chrome UA + ok.ru Referer)',
      headers: {
        'Referer': 'https://ok.ru/',
        'Origin': 'https://ok.ru',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Range': 'bytes=0-65535'
      }
    },
    {
      label: 'ExoPlayer UA + Referer (simulating Android TV player)',
      headers: {
        'Referer': 'https://ok.ru/',
        'User-Agent': 'ExoPlayerLib/2.18.5 (Linux; Android 12)',
        'Range': 'bytes=0-65535'
      }
    },
    {
      label: 'Bare minimum (Referer only)',
      headers: {
        'Referer': 'https://ok.ru/',
        'Range': 'bytes=0-65535'
      }
    },
    {
      label: 'No headers at all',
      headers: { 'Range': 'bytes=0-65535' }
    }
  ];

  console.log('\n=== Step 2: Testing each approach immediately ===');
  for (const a of attempts) {
    const r = await fetch(cdnUrl, { headers: a.headers });
    const bytes = r.ok ? (await r.arrayBuffer()).byteLength : 0;
    console.log(`  [${r.status}] ${a.label}${r.ok ? ' → got ' + bytes + ' bytes' : ''}`);
  }

  console.log('\n=== Step 3: What is THIS machine\'s public IP? ===');
  const ipRes = await fetch('https://api.ipify.org?format=json');
  const ipJson = await ipRes.json();
  console.log('This machine public IP:', ipJson.ip);
  console.log('srcIp in token was:    ', u.searchParams.get('srcIp'));
  console.log('IPs match?', ipJson.ip === u.searchParams.get('srcIp'));
}

testIpEnforcement().catch(console.error);
