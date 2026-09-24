const { execFile } = require('child_process');
const path = require('path');
const https = require('https');

async function extractIndia(url) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'src', 'providers', 'run_gasm_india.js');
    
    // Parse the channel string (e.g. from /embed/nfl-network)
    let channel = url;
    const match = url.match(/embed(?:-noads)?\/(?:admin\/)?([^\/?]+)/);
    if (match) channel = match[1];

    execFile(process.execPath, [scriptPath, channel, '', 'EMPTY', url], { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
          console.error("STDOUT:", stdout);
          console.error("STDERR:", stderr);
        return reject(error);
      }
      
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('http') && line.includes('.m3u8')) {
          return resolve(line.trim());
        }
      }
      reject(new Error("No M3U8 found in output\nSTDOUT:\n" + stdout));
    });
  });
}

function getActiveStream() {
    return new Promise((resolve, reject) => {
        https.get('https://api.ppv.st/api/streams', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    for (const category of json.streams) {
                        for (const stream of category.streams) {
                            if (stream.iframe && stream.iframe.includes('embedindia.st')) {
                                return resolve({ name: stream.name, iframe: stream.iframe });
                            }
                        }
                    }
                    reject(new Error("No embedindia streams found"));
                } catch(e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function test() {
    try {
        console.log("Fetching active streams from ppv.st...");
        const stream = await getActiveStream();
        console.log(`Found active stream: ${stream.name}`);
        console.log(`Iframe URL: ${stream.iframe}`);
        
        console.log("Running WASM interception on iframe...");
        const m3u8 = await extractIndia(stream.iframe);
        console.log("SUCCESS! Got m3u8:");
        console.log(m3u8);
    } catch(e) {
        console.error("TEST FAILED:", e);
    }
}

test();
