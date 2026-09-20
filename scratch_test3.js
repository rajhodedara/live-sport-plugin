const fetch = require('node-fetch');

async function test() {
  for (const domain of ['dlstreams.st', 'dlive.sx']) {
      console.log('--- ' + domain + ' ---');
      for (const folder of ['stream', 'cast', 'watch', 'player', 'plus', 'casting']) {
          try {
              const res = await fetch(`https://${domain}/${folder}/stream-157.php`, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                  'Referer': `https://${domain}/`
                }
              });
              const html = await res.text();
              const match = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
              console.log(`${folder} -> Iframe: ${match ? match[1] : 'Not Found'} (Status: ${res.status})`);
          } catch (e) {
              console.error(`${folder} -> Error: ${e.message}`);
          }
      }
  }
}
test();
