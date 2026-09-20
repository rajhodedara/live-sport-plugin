import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

async function run() {
  const base = 'https://dlstreams.st';
  const jsonUrl = `${base}/schedule/schedule-generated.json`;
  
  console.log(`Fetching ${jsonUrl} using got-scraping`);
  
  let jsonText;
  try {
    const res = await gotScraping({
      url: jsonUrl,
      headers: {
        'Referer': base + '/'
      }
    });
    jsonText = res.body;
  } catch (err) {
    console.error("Failed to fetch schedule json:", err.message);
    return;
  }
  
  const data = JSON.parse(jsonText);
  const streamIds = new Set();
  
  for (const day in data) {
    for (const cat in data[day]) {
      for (const ev of data[day][cat]) {
        if (ev.channels) {
          for (const ch of ev.channels) {
            if (ch.channel_id && ch.channel_id !== '00') {
               streamIds.add(ch.channel_id);
            }
          }
        }
      }
    }
  }

  console.log(`Found ${streamIds.size} stream IDs from JSON.`);

  const folders = ['stream', 'cast', 'watch', 'player', 'plus', 'casting'];
  const iframeDomains = new Set();
  
  const ids = Array.from(streamIds);
  const chunks = [];
  const CONCURRENCY = 15;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    chunks.push(ids.slice(i, i + CONCURRENCY));
  }

  let checked = 0;
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (id) => {
      let found = false;
      for (const folder of folders) {
        if (found) break;
        const playerUrl = `${base}/${folder}/stream-${id}.php`;
        try {
          const res = await gotScraping({
            url: playerUrl,
            headers: { 'Referer': base + '/' },
            timeout: { request: 5000 }
          });
          const phtml = res.body;
          
          const iframeMatch = phtml.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
          if (iframeMatch && iframeMatch[1]) {
            let iframeUrl = iframeMatch[1];
            if (iframeUrl.startsWith('//')) {
              iframeUrl = 'https:' + iframeUrl;
            } else if (iframeUrl.startsWith('/')) {
              iframeUrl = new URL(iframeUrl, playerUrl).toString();
            }

            try {
              const embedOrigin = new URL(iframeUrl).hostname;
              if (!iframeDomains.has(embedOrigin)) {
                 iframeDomains.add(embedOrigin);
                 console.log("NEW DOMAIN FOUND:", embedOrigin);
              }
              found = true;
            } catch (e) {}
          }
        } catch (err) {
           // ignore timeouts
        }
      }
    }));
    checked += chunk.length;
    console.log(`Checked ${checked}/${ids.length} streams...`);
  }

  console.log("Found Iframe Domains:", Array.from(iframeDomains));
}

run();
