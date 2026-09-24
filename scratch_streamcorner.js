const { fetch } = require('undici');

async function scrape() {
    try {
        const res = await fetch('https://streamcorner.st/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        const text = await res.text();
        console.log("Status:", res.status);
        console.log("HTML Start:", text.substring(0, 1000));
        
        // Find links
        const matches = text.match(/href="([^"]+)"/g) || [];
        console.log("Found links:", matches.slice(0, 20));
    } catch (e) {
        console.error(e);
    }
}
scrape();
