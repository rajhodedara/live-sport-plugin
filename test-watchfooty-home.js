const { safeFetch } = require('./src/impitClient');
const cheerio = require('cheerio');

async function test() {
  try {
    const res = await safeFetch('https://watchfooty.st/schedule', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    
    // Look for matches
    const matches = [];
    $('a[href*="/match/"]').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      matches.push({ href, text });
    });
    
    console.log("Matches found:", matches.length);
    console.log(matches.slice(0, 10));
  } catch(e) {
    console.error(e);
  }
}
test();
