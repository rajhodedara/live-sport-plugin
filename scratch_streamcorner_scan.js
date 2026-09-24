const { fetch } = require('undici');

async function scan() {
    try {
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
        const js1 = await (await fetch('https://streamcorner.st/assets/kWVEzbTr.js', {headers})).text();
        const js2 = await (await fetch('https://streamcorner.st/assets/CepRsIsx.js', {headers})).text();
        
        console.log("JS1 Length:", js1.length);
        console.log("JS2 Length:", js2.length);
        
        // Find URLs
        const urlRegex = /https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^"'\s]*)?/g;
        const urls = new Set([...(js1.match(urlRegex) || []), ...(js2.match(urlRegex) || [])]);
        
        console.log("Extracted URLs:");
        Array.from(urls).filter(u => !u.includes('react') && !u.includes('w3.org')).forEach(u => console.log(u));
    } catch (e) {
        console.error(e);
    }
}
scan();
