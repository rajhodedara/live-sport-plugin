const cheerio = require('cheerio');
const { safeFetch } = require('./src/impitClient.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

async function fetchHtml(url, referer) {
  const headers = { 'User-Agent': UA };
  if (referer) headers['Referer'] = referer;
  
  try {
    const response = await safeFetch(url, { headers, attempts: 2, timeoutMs: 10000 });
    if (!response.ok) return null;
    return await response.text();
  } catch (err) {
    return null;
  }
}

async function run() {
  const base = 'https://dlstreams.st';
  const jsonUrl = `${base}/schedule/schedule-generated.json`;
  
  console.log(`Fetching ${jsonUrl} using impit`);
  const jsonText = await fetchHtml(jsonUrl, base + '/');
  
  let streamIds = new Set();

  if (!jsonText) {
    console.log("Failed to fetch schedule json. Trying home page.");
    const html = await fetchHtml(base + '/', base + '/');
    if (html) {
      const $ = cheerio.load(html);
      $('.schedule__channels a').each((_, a) => {
        const href = $(a).attr('href') || '';
        const idMatch = href.match(/id=(\d+)/);
        if (idMatch && idMatch[1] !== '00') {
          streamIds.add(idMatch[1]);
        }
      });
    } else {
      console.log("Failed to fetch home page too.");
      return;
    }
  } else {
    try {
        const data = JSON.parse(jsonText);
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
    } catch (e) {
        console.error("Failed to parse JSON");
    }
  }

  console.log(`Found ${streamIds.size} stream IDs.`);

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
        const phtml = await fetchHtml(playerUrl, `${base}/`);
        if (!phtml) continue;

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
      }
    }));
    checked += chunk.length;
    console.log(`Checked ${checked}/${ids.length} streams...`);
  }

  console.log("Found Iframe Domains:", Array.from(iframeDomains));
}

run();
