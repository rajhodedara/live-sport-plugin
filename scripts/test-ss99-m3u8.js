const { request } = require('undici');

async function testFetch() {
  const m3u8Url = process.env.SS99_TEST_M3U8;
  if (!m3u8Url) {
    console.error('SS99_TEST_M3U8 is not set; skipping.');
    return;
  }
  console.log('Fetching m3u8 playlist...');
  const res = await request(m3u8Url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': 'https://streamsports99.fun/',
      'Origin': 'https://streamsports99.fun'
    }
  });
  console.log('Status:', res.statusCode);
  const body = await res.body.text();
  console.log('Body:\n', body);
}
testFetch().catch(console.error);
