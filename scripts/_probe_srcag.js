const undici = require('undici');

async function testProperUa() {
  const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

  // Mint with FULL Chrome UA
  const { body } = await undici.request('https://ok.ru/videoembed/15812810246868', {
    headers: {
      'User-Agent': chromeUA,
      'Referer': 'https://ok.ru/'
    }
  });
  const html = await body.text();
  const raw = html.split('data-options=')[1];
  const q = raw[0];
  const json = JSON.parse(raw.slice(1).split(q)[0].replace(/&quot;/g, '"'));
  const meta = typeof json.flashvars.metadata === 'string' ? JSON.parse(json.flashvars.metadata) : json.flashvars.metadata;
  const best = meta.videos[meta.videos.length - 1];
  const u = new URL(best.url);

  console.log('srcAg with full Chrome UA:', u.searchParams.get('srcAg'));
  console.log('srcIp:', u.searchParams.get('srcIp'));
  console.log('expires:', new Date(parseInt(u.searchParams.get('expires'))).toISOString());
  console.log();

  const url = best.url;

  const tests = [
    {
      label: 'Chrome UA + Referer (exact match to srcAg=CHROME)',
      headers: { 'User-Agent': chromeUA, 'Referer': 'https://ok.ru/' }
    },
    {
      label: 'ExoPlayer UA + Referer (mismatched srcAg)',
      headers: { 'User-Agent': 'ExoPlayerLib/2.18.5 (Linux; Android 12)', 'Referer': 'https://ok.ru/' }
    },
    {
      label: 'No headers at all',
      headers: {}
    }
  ];

  for (const t of tests) {
    const r = await fetch(url, { headers: { Range: 'bytes=0-65535', ...t.headers } });
    const buf = Buffer.from(await r.arrayBuffer());
    console.log('[' + r.status + ']', t.label, '-', buf.length, 'bytes');
    if (!r.ok) console.log('       body:', buf.toString().slice(0, 50));
  }

  console.log('\nFRESH CDN URL (copy for cross-IP test):');
  console.log(best.url);
}

testProperUa().catch(console.error);
