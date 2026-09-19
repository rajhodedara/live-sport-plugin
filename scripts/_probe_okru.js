const undici = require('undici');

async function probeAllFormats() {
  const { body } = await undici.request('https://ok.ru/videoembed/15812810246868', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://ok.ru/' }
  });
  const html = await body.text();
  const raw = html.split('data-options=')[1];
  const q = raw[0];
  const jsonStr = raw.slice(1).split(q)[0].replace(/&quot;/g, '"');
  const parsed = JSON.parse(jsonStr);
  const meta = typeof parsed.flashvars.metadata === 'string' ? JSON.parse(parsed.flashvars.metadata) : parsed.flashvars.metadata;

  console.log('=== ok.ru metadata keys ===');
  console.log(Object.keys(meta).join(', '));

  const metaStr = JSON.stringify(meta);
  const hasM3u8 = metaStr.includes('.m3u8');
  const hasMpd = metaStr.includes('.mpd') || metaStr.includes('dash') || metaStr.includes('manifest');
  console.log('\nHas .m3u8 (HLS)?', hasM3u8);
  console.log('Has DASH?', hasMpd);
  console.log('Video formats in metadata:', meta.videos ? meta.videos.map(v => v.name).join(', ') : 'none');
  console.log('\nTotal video entries:', meta.videos ? meta.videos.length : 0);
  if (meta.videos && meta.videos.length > 0) {
    console.log('Sample entry:', JSON.stringify(meta.videos[0]).slice(0, 200));
  }

  // Check if ok.ru embed page URL itself works as external URL (for browser playback)
  console.log('\n=== Testing ok.ru embed as web-playable URL ===');
  const embedUrl = 'https://ok.ru/videoembed/15812810246868';
  const embedRes = await undici.request(embedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://ok.ru/' }
  });
  console.log('Embed page HTTP status:', embedRes.statusCode);
  const embedHtml = await embedRes.body.text();
  console.log('Has video player?', embedHtml.includes('video') || embedHtml.includes('flashvars'));
}

probeAllFormats().catch(console.error);
