const { extractSportsEmbed } = require('./src/providers/SportsEmbedExtractor');
const { safeFetch } = require('./src/impitClient');

async function test() {
  const embedUrl = 'https://sportsembed.su/embed/6028327/club-america-columbus-crew/platinum/1';
  try {
    console.log("Extracting...");
    const m3u8 = await extractSportsEmbed(embedUrl);
    console.log("Extracted:", m3u8);

    console.log("Fetching M3U8...");
    const res = await safeFetch(m3u8, {
      headers: {
        'Origin': 'https://sportsembed.su',
        'Referer': 'https://sportsembed.su/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': '*/*'
      },
      timeoutMs: 10000
    });
    console.log("Status:", res.status);
    const body = await res.text();
    console.log("Body length:", body.length);
    console.log("Body start:", body.substring(0, 200));
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
