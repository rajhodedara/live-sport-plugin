const { safeFetch } = require('./src/impitClient');

async function test() {
  const url = 'https://netanyahu.indianservers.st/secure/omNaLhsgsDOaRUuiyFMKgPTjIbHboXYq/1790067600/1790114400/darts1/tracks-v1a1/mono.ts.m3u8';
  const headers = {
    'Referer': 'https://embedindia.st/',
    'Origin': 'https://embedindia.st',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  };
  try {
    console.log("Fetching...");
    const res = await safeFetch(url, { headers, timeoutMs: 10000 });
    console.log("Status:", res.status);
    const body = await res.text();
    console.log("Body length:", body.length);
    console.log("Body:", body);
  } catch (e) {
    console.error("Error fetching:", e);
  }
}

test();
