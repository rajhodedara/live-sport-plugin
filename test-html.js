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
    console.log("Status:", res.status);
    const body = await res.text();
    console.log("Contains iframe?", body.includes('<iframe'));
    const iframes = body.match(/<iframe[^>]+>/g);
    console.log("Iframes:", iframes);
  } catch (e) {
    console.error("Error fetching:", e);
  }
}

test();
