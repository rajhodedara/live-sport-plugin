const undici = require('undici');

async function probeDailymotion() {
  const container = require('../src/container');
  const p = container.resolve('replayzoneProvider');
  const matches = await p.getMatches();

  // Find a match with dailymotion
  const dmMatch = matches.find(m => m.sources && m.sources.some(s => (s.id || s.url || '').includes('dailymotion')));
  if (!dmMatch) { console.log('No dailymotion match found'); return; }

  const dmSrc = dmMatch.sources.find(s => (s.id || s.url || '').includes('dailymotion'));
  const embedUrl = dmSrc.id || dmSrc.url;
  console.log('Dailymotion embed URL:', embedUrl);

  const { body } = await undici.request(embedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://soccerfull.net/' }
  });
  const html = await body.text();
  console.log('Status: 200');

  // Check for HLS URL
  const hlsMatch = html.match(/https?[^"'\\]+\.m3u8[^"'\\]*/);
  const qualitiesMatch = html.match(/"qualities":\s*\{[^}]+}/);
  const streamUrl = html.match(/(https?:\/\/[^"'\\]+(?:\.mp4|\.m3u8)[^"'\\]*)/);
  console.log('HLS URL found:', hlsMatch ? hlsMatch[0].slice(0, 100) : 'none');
  console.log('Qualities block found:', qualitiesMatch ? qualitiesMatch[0].slice(0, 100) : 'none');
  console.log('Direct stream URL:', streamUrl ? streamUrl[0].slice(0, 100) : 'none');
}

probeDailymotion().catch(console.error);
