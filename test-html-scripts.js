const { safeFetch } = require('./src/impitClient');

async function test() {
  const url = 'https://sportsembed.su/embed/faadc987331/noppert-d-de-graaf-j/hd/1';
  const headers = {
    'Referer': 'https://watchfooty.st/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': 'text/html'
  };
  try {
    const res = await safeFetch(url, { headers, timeoutMs: 10000 });
    const body = await res.text();
    const scripts = body.match(/<script[^>]*>.*?<\/script>/gis) || [];
    console.log("Scripts found:", scripts.length);
    scripts.forEach((s, i) => {
        if (s.includes('src=')) {
            console.log(`[${i}] SRC:`, s.match(/src="([^"]+)"/)?.[1]);
        } else {
            console.log(`[${i}] INLINE:`, s.substring(0, 200).replace(/\n/g, ' '));
        }
    });
  } catch (e) {
    console.error("Error fetching:", e);
  }
}

test();
