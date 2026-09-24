const fs = require('fs');
const https = require('https');

https.get('https://api.ppv.st/api/streams', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            const domains = new Set();
            const iframes = [];
            
            for (const category of json.streams) {
                for (const stream of category.streams) {
                    if (stream.iframe) {
                        iframes.push(stream.iframe);
                        try {
                            const url = new URL(stream.iframe);
                            domains.add(url.hostname);
                        } catch (e) {
                            domains.add(stream.iframe);
                        }
                    }
                }
            }
            
            console.log("Total streams:", iframes.length);
            console.log("Unique iframe domains found:");
            console.log(Array.from(domains));
            
        } catch (e) {
            console.error("Error parsing JSON:", e);
        }
    });
}).on('error', err => console.error("Request error:", err));
