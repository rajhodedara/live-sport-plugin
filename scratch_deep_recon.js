const net = require('net');
const fetch = require('node-fetch');

const TARGET_IP = '213.21.239.30';
const PORTS_TO_SCAN = [21, 22, 80, 443, 8080, 8443, 3306, 6379, 27017, 8888, 9000];
const DOMAINS = ['https://dlstreams.st', 'https://assetrage.net', 'https://tiestep.top'];

async function scanPort(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let isOpen = false;
    socket.setTimeout(2000);
    socket.on('connect', () => { isOpen = true; socket.destroy(); });
    socket.on('timeout', () => { socket.destroy(); });
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => { resolve({ port, isOpen }); });
    socket.connect(port, TARGET_IP);
  });
}

async function extractJsEndpoints(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': url
      },
      timeout: 5000
    });
    if (!res.ok) return [];
    
    const html = await res.text();
    const scriptRegex = /<script[^>]+src=["']?([^"'\s>]+)["']?/gi;
    const jsFiles = [];
    let match;
    
    while ((match = scriptRegex.exec(html)) !== null) {
      if (match[1].endsWith('.js')) {
        jsFiles.push(match[1].startsWith('http') ? match[1] : `${url}${match[1].startsWith('/') ? '' : '/'}${match[1]}`);
      }
    }
    
    const endpoints = new Set();
    for (const jsUrl of jsFiles) {
      try {
        const jsRes = await fetch(jsUrl, { timeout: 3000 });
        if (jsRes.ok) {
          const jsCode = await jsRes.text();
          // Look for API endpoints, URLs, or IP addresses in the JS code
          const endpointRegex = /(https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[a-zA-Z0-9./_-]+)/g;
          let epMatch;
          while ((epMatch = endpointRegex.exec(jsCode)) !== null) {
            endpoints.add(epMatch[1]);
          }
        }
      } catch (e) {}
    }
    return Array.from(endpoints);
  } catch (e) {
    return [];
  }
}

async function runRecon() {
  console.log(`\n[Recon] Scanning target IP: ${TARGET_IP} for exposed services...`);
  const portResults = await Promise.all(PORTS_TO_SCAN.map(scanPort));
  const openPorts = portResults.filter(p => p.isOpen).map(p => p.port);
  console.log(`[Recon] Open Ports found: ${openPorts.length > 0 ? openPorts.join(', ') : 'None (Strict Firewall)'}`);

  console.log(`\n[Recon] Deep scraping domains for hidden endpoints & APIs...`);
  for (const domain of DOMAINS) {
    console.log(`\n[Recon] Analyzing ${domain}...`);
    const endpoints = await extractJsEndpoints(domain);
    if (endpoints.length > 0) {
      console.log(`[Recon] Found ${endpoints.length} embedded endpoints/routes:`);
      endpoints.slice(0, 10).forEach(ep => console.log(`  -> ${ep}`));
      if (endpoints.length > 10) console.log(`  -> ...and ${endpoints.length - 10} more.`);
    } else {
      console.log(`[Recon] No endpoints extracted or connection timed out.`);
    }
  }
}

runRecon();
