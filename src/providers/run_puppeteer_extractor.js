const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const args = process.argv.slice(2);
const targetUrl = args[0];
const referer = args[1];

if (!targetUrl) {
    console.error("No target URL provided");
    process.exit(1);
}

(async () => {
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });
        
        const page = await browser.newPage();
        
        if (referer && referer !== 'EMPTY') {
            await page.setExtraHTTPHeaders({
                'Referer': referer
            });
        }
        
        await page.setRequestInterception(true);
        
        let foundM3u8 = null;
        
        page.on('request', req => {
            req.continue();
        });
        
        page.on('response', async res => {
            let url = res.url();
            if (url.includes('url=')) {
                try {
                    const urlMatch = url.match(/url=([^&]+)/);
                    if (urlMatch) {
                        const decoded = decodeURIComponent(urlMatch[1]);
                        if (decoded.includes('.m3u8')) url = decoded;
                    }
                } catch(e) {}
            }
            if (url.includes('.m3u8') && !url.includes('blank.m3u8') && !foundM3u8) {
                foundM3u8 = url;
                console.log(JSON.stringify({ file: url }));
                await browser.close();
                process.exit(0);
            }
        });
        
        setTimeout(async () => {
            console.error("Timeout waiting for m3u8");
            if (browser) await browser.close();
            process.exit(1);
        }, 35000);
        
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Check for iframes every 2 seconds, and try to click play
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            if (foundM3u8) break;
            
            // Attempt to click anything that looks like a play button or just play the video
            await page.evaluate(() => {
                try {
                    const video = document.querySelector('video');
                    if (video) video.play();
                } catch(e) {}
                try {
                    document.querySelectorAll('.jw-video, .jw-media, video, .vjs-big-play-button, .vjs-tech, .jw-display-icon-display').forEach(el => {
                        el.click();
                    });
                } catch(e) {}
            });
            
            const iframeM3u8 = await page.evaluate(() => {
                let found = null;
                document.querySelectorAll('iframe').forEach(f => {
                    try {
                        let src = f.src || '';
                        let urlMatch = src.match(/url=([^&]+)/);
                        if (urlMatch) {
                            let decoded = decodeURIComponent(urlMatch[1]);
                            if (decoded.includes('.m3u8')) found = decoded;
                        }
                    } catch(e) {}
                });
                return found;
            });
            
            if (iframeM3u8 && !foundM3u8) {
                foundM3u8 = iframeM3u8;
                console.log(JSON.stringify({ file: iframeM3u8 }));
                await browser.close();
                process.exit(0);
            }
        }
        
        if (!foundM3u8) {
            console.error("Could not find m3u8 in network traffic or iframes");
            await browser.close();
            process.exit(1);
        }
        
    } catch (err) {
        console.error(err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
