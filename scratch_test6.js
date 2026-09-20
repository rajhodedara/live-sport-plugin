const fetch = require('node-fetch');

async function t(){ 
    for(let id of [105, 157, 415, 712, 943, 771, 137, 402, 383, 585]) {
        try {
            let r = await fetch(`https://dlstreams.st/stream/stream-${id}.php`, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                  'Referer': 'https://dlstreams.st/'
                }
            }); 
            let html = await r.text(); 
            let m = html.match(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/i);
            console.log(id, m ? m[1] : 'no iframe');
        } catch(e) {
            console.log(id, e.message);
        }
    }
} 
t();
