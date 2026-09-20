const fetch = require('node-fetch');

class DaddyLiveProvider {
  decodeEconfig(rawEconfig) {
    if (!rawEconfig || typeof rawEconfig !== 'string') return null;
    try {
      const order = [2, 0, 3, 1];
      const partsCount = 4;
      const decodedB64 = Buffer.from(rawEconfig, 'base64').toString('utf-8');
      const len = decodedB64.length;
      if (len < partsCount) return null;

      const partLen = Math.ceil(len / partsCount);
      const parts = [];
      let offset = 0;
      for (let i = 0; i < partsCount; i++) {
        parts.push(decodedB64.substr(offset, partLen));
        offset += partLen;
      }

      const orderedParts = [];
      for (let i = 0; i < order.length; i++) {
        let str = String(parts[i]);
        str = str.slice(0, 3) + str.slice(4);
        orderedParts[order[i]] = Buffer.from(str, 'base64').toString('utf-8');
      }

      const combined = orderedParts.join('');
      const finalJsonStr = Buffer.from(combined, 'base64').toString('utf-8');
      return JSON.parse(finalJsonStr);
    } catch (_) {
      return null;
    }
  }
}

async function test() {
  const url = 'https://assetrage.net/e/7i35ykszucqbs';
  try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Referer': 'https://dlstreams.st/'
        }
      });
      const html = await res.text();
      const econfigMatch = html.match(/_econfig\s*=\s*['"]([^'"]+)['"]/);
      if (econfigMatch) {
          const provider = new DaddyLiveProvider();
          const decoded = provider.decodeEconfig(econfigMatch[1]);
          console.log('Decoded:', JSON.stringify(decoded, null, 2));
      } else {
          console.log('No _econfig found');
      }
  } catch (e) {
      console.error(e);
  }
}
test();
