const { safeFetch } = require('./src/impitClient');

async function test() {
  const url = 'https://lb3.wfty.st/secure/T46zdH5dxhp0eRzd8jZGuA/hd/dobey-c-crabtree-c/1/674e3cbe70a/1790110168/playlist.m3u8';
  const headers = {
    'Referer': 'https://sportsembed.su/',
    'Origin': 'https://sportsembed.su',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
  };
  try {
    const res = await safeFetch(url, { headers, timeoutMs: 10000 });
    console.log("Status:", res.status);
    const body = await res.text();
    console.log("Body length:", body.length);
    console.log("Snippet:", body.substring(0, 200));
  } catch (e) {
    console.error("Error fetching:", e);
  }
}

test();
