const https = require('https');

const API_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID = process.env.RENDER_SERVICE_ID || 'srv-d9dvflrrjlhs73behjtg';
const OWNER_ID = process.env.RENDER_OWNER_ID || 'tea-d55futbuibrs7391q0r0';

if (!API_KEY) {
  console.error('Missing RENDER_API_KEY environment variable.');
  process.exit(1);
}

function renderReq(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.render.com',
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'application/json'
      }
    };
    https.get(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, data });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const logsRes = await renderReq(`/v1/logs?ownerId=${OWNER_ID}&resource=${SERVICE_ID}&limit=100&direction=backward`);
  if (Array.isArray(logsRes.data)) {
    const list = logsRes.data.filter(l => {
      const msg = (l.message || '').toLowerCase();
      return msg.includes('streamsports99') || msg.includes('ss99') || msg.includes('cdnlivetv');
    });
    console.log(`Found ${list.length} StreamSports99 log entries:`);
    list.forEach(l => console.log(`[${l.timestamp}] ${l.message}`));
  }
}

main().catch(console.error);
