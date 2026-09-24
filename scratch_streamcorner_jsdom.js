const { JSDOM } = require('jsdom');
const { fetch } = require('undici');

async function intercept() {
    const htmlRes = await fetch('https://streamcorner.st/', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await htmlRes.text();

    const dom = new JSDOM(html, {
        url: "https://streamcorner.st/",
        runScripts: "dangerously",
        resources: "usable",
        pretendToBeVisual: true
    });

    const win = dom.window;
    
    // Intercept fetch
    const origFetch = win.fetch;
    win.fetch = async function(...args) {
        console.log("FETCH:", args[0]);
        return origFetch.apply(this, args);
    };

    // Intercept XHR
    const origOpen = win.XMLHttpRequest.prototype.open;
    win.XMLHttpRequest.prototype.open = function(...args) {
        console.log("XHR:", args[1]);
        return origOpen.apply(this, args);
    };

    console.log("Waiting for JS to execute...");
    setTimeout(() => {
        console.log("DOM BODY:", win.document.body.innerHTML.substring(0, 1000));
        process.exit(0);
    }, 3000);
}
intercept();
