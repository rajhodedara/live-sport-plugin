const fetch = require('node-fetch');

const CHANNELS_TO_SNIPE = [105, 157, 415, 712, 943, 771, 137, 402, 383, 585, 100, 101, 102, 103, 104, 200, 201, 300, 301, 400];
const UNIQUE_DOMAINS = new Set();
const CONCURRENCY = 5;

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': 'https://dlstreams.st/'
        },
        timeout: 5000 // aggressive 5 second timeout so we don't hang
      });
      if (res.ok) return await res.text();
    } catch (e) {
      // ignore and retry
    }
  }
  return null;
}

async function snipe() {
  console.log(`[Sniper] Starting aggressive recon on ${CHANNELS_TO_SNIPE.length} DaddyLive channels...`);
  
  for (let i = 0; i < CHANNELS_TO_SNIPE.length; i += CONCURRENCY) {
    const batch = CHANNELS_TO_SNIPE.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (id) => {
      const html = await fetchWithRetry(`https://dlstreams.st/stream/stream-${id}.php`);
      if (html) {
        const iframeMatch = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
        if (iframeMatch && iframeMatch[1]) {
          try {
            const url = new URL(iframeMatch[1].startsWith('http') ? iframeMatch[1] : `https:${iframeMatch[1]}`);
            if (!UNIQUE_DOMAINS.has(url.hostname)) {
              UNIQUE_DOMAINS.add(url.hostname);
              console.log(`[Sniper] HIT! Found active domain: ${url.hostname} on channel ${id}`);
            }
          } catch(e) {}
        }
      }
    }));
  }
  
  console.log('\n[Sniper] Recon complete. Active Domains mapped:');
  console.log(Array.from(UNIQUE_DOMAINS));
}

snipe();
