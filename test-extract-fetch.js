const { extractSportsEmbed } = require('./src/providers/SportsEmbedExtractor');
const { safeFetch } = require('./src/impitClient');

async function run() {
    try {
        const url = await extractSportsEmbed('https://sportsembed.su/embed/674e3cbe70a/dobey-c-crabtree-c/hd/1');
        console.log("Extracted URL:", url);

        const headers = {
            'Referer': 'https://sportsembed.su/',
            'Origin': 'https://sportsembed.su',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
        };
        const res = await safeFetch(url, { headers, timeoutMs: 10000 });
        console.log("Status:", res.status);
        const body = await res.text();
        console.log("Snippet:", body.substring(0, 100));
    } catch(e) {
        console.error("Error:", e);
    }
}
run();
