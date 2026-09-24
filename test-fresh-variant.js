const { execFile } = require('child_process');
const path = require('path');
const { safeFetch } = require('./src/impitClient');

async function extractIndia(url) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'src', 'providers', 'run_gasm_india.js');
    let channel = url;
    const match = url.match(/embed(?:-noads)?\/(?:admin\/)?([^\/?]+)/);
    if (match) channel = match[1];

    execFile(process.execPath, [scriptPath, channel, '', 'EMPTY', url], { timeout: 15000 }, (error, stdout) => {
      if (error) return reject(error);
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('http') && line.includes('.m3u8')) {
          let u = line.trim();
          if (u.startsWith('"file": "')) u = u.replace('"file": "', '').replace('",', '');
          return resolve(u);
        }
      }
      reject(new Error("No M3U8 found in output"));
    });
  });
}

async function test() {
  const url = 'https://embedindia.st/embed/players-championship-29---den-bosch-29227';
  try {
    const freshUrl = await extractIndia(url);
    console.log("Fresh URL:", freshUrl);
    
    // Fetch master
    let res = await safeFetch(freshUrl, {
      headers: {
        'Referer': 'https://embedindia.st/',
        'Origin': 'https://embedindia.st',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
      }
    });
    let body = await res.text();
    const lines = body.split('\n');
    let variantPath = '';
    for (const line of lines) {
      if (line.endsWith('.m3u8')) {
        variantPath = line.trim();
        break;
      }
    }
    
    if (!variantPath) {
      console.log("No variant found!");
      return;
    }
    
    const variantUrl = new URL(variantPath, freshUrl).toString();
    console.log("Variant URL:", variantUrl);
    
    res = await safeFetch(variantUrl, {
      headers: {
        'Referer': 'https://embedindia.st/',
        'Origin': 'https://embedindia.st',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
      }
    });
    console.log("Variant Status:", res.status);
    body = await res.text();
    console.log("Variant Body:");
    console.log(body.substring(0, 1000));
  } catch (e) {
    console.error(e);
  }
}

test();
