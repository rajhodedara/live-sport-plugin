const { execFile } = require('child_process');
const path = require('path');

async function extractIndia(url) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'src', 'providers', 'run_gasm_india.js');
    
    // Parse the channel string (e.g. from /embed-noads/rally-tv)
    let channel = url;
    const match = url.match(/embed(?:-noads)?\/(?:admin\/)?([^\/?]+)/);
    if (match) channel = match[1];

    execFile(process.execPath, [scriptPath, channel, '', 'EMPTY', url], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        return reject(error);
      }
      
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('http') && line.includes('.m3u8')) {
          return resolve(line.trim());
        }
      }
      reject(new Error("No M3U8 found in output"));
    });
  });
}

async function test() {
  const url = 'https://embedindia.st/embed/players-championship-29---den-bosch-29227';
  console.log("Run 1...");
  try {
    const url1 = await extractIndia(url);
    console.log("URL 1:", url1);
    
    console.log("Waiting 5 seconds...");
    await new Promise(r => setTimeout(r, 5000));
    
    console.log("Run 2...");
    const url2 = await extractIndia(url);
    console.log("URL 2:", url2);
    
    if (url1 === url2) {
      console.log("Tokens are identical! This means WASM generates the exact same URL.");
    } else {
      console.log("Tokens are different! WASM generates fresh URLs.");
    }
  } catch (e) {
    console.error(e);
  }
}

test();
