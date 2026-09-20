const fetch = require('node-fetch');

async function test() {
  const url = 'https://assetrage.net/e/r471l1r6gnego';
  try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': 'https://dlstreams.st/'
        }
      });
      const html = await res.text();
      console.log('HTML contains _econfig:', html.includes('_econfig'));
      const econfigMatch = html.match(/_econfig\s*=\s*['"]([^'"]+)['"]/);
      if (econfigMatch) {
          console.log('_econfig payload:', econfigMatch[1].substring(0, 50) + '...');
      }
      const iframeMatch = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
      if (iframeMatch) {
          console.log('Nested iframe:', iframeMatch[1]);
      }
  } catch (e) {
      console.error(e);
  }
}
test();
