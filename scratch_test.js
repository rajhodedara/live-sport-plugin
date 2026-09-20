const fetch = require('node-fetch');

async function test() {
  for (const domain of ['dlstreams.st', 'dlive.sx']) {
    try {
      const res = await fetch(`https://${domain}/stream/stream-712.php`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': `https://${domain}/`
        }
      });
      const html = await res.text();
      const match = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
      console.log(`Domain ${domain} -> Iframe: ${match ? match[1] : 'Not Found'}`);
    } catch (e) {
      console.error(`Domain ${domain} -> Error: ${e.message}`);
    }
  }
}
test();
