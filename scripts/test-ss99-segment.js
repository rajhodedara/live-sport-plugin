const { request } = require('undici');

async function testSegment() {
  const m3u8Url = process.env.SS99_TEST_M3U8;
  if (!m3u8Url) {
    console.error('SS99_TEST_M3U8 is not set; skipping.');
    return;
  }
  const res = await request(m3u8Url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Referer': 'https://streamsports99.fun/',
      'Origin': 'https://streamsports99.fun'
    }
  });
  const body = await res.body.text();
  const segmentPath = body.split('\n').find(line => line.startsWith('/stream-segment'));
  if (segmentPath) {
    const fullSeg = 'https://cdnlivetv.tv' + segmentPath.trim();
    console.log('Testing segment fetch with https://streamsports99.fun/ referer:');
    const sRes1 = await request(fullSeg, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': 'https://streamsports99.fun/',
        'Origin': 'https://streamsports99.fun'
      }
    });
    console.log('Referer streamsports99.fun status:', sRes1.statusCode);

    console.log('Testing segment fetch with https://cdnlivetv.is/ referer:');
    const sRes2 = await request(fullSeg, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Referer': 'https://cdnlivetv.is/',
        'Origin': 'https://cdnlivetv.is'
      }
    });
    console.log('Referer cdnlivetv.is status:', sRes2.statusCode);
  }
}
testSegment().catch(console.error);
