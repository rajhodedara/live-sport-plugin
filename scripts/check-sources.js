const axios = require('axios');

const sources = [
  { name: 'WatchFooty', url: 'https://api.watchfooty.st/api/v1/matches/football' },
  { name: 'TimStreams', url: 'https://timst.cfd/api/live-upcoming' },
  { name: 'StreamSports', url: 'https://api.cdnlivetv.is/matches' },
  { name: 'StreamSports99', url: 'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip' },
  { name: 'Streamic', url: 'https://streamic.st/api/J.php' },
  { name: 'StreamFree', url: 'https://streamfree.top/streams' },
  { name: 'SportyHunter', url: 'https://sportyhunter.xyz' },
  { name: 'PPV / BinTv', url: 'https://api.ppv.st/api/streams' },
  { name: 'NTV', url: 'http://ntv.cx' },
  { name: 'IptvOrg', url: 'https://iptv-org.github.io/api/channels.json' },
  { name: 'CdnLive', url: 'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free' },
  { name: 'DaddyLive', url: 'https://dlstreams.st/schedule/schedule-generated.json' }
];

async function checkSources() {
  console.log('Checking streaming sources...\n');
  
  const results = await Promise.allSettled(sources.map(async (source) => {
    try {
      const response = await axios.get(source.url, { timeout: 10000 });
      return { ...source, status: 'OK', statusCode: response.status };
    } catch (error) {
      return { 
        ...source, 
        status: 'FAILED', 
        error: error.response ? `HTTP ${error.response.status}` : error.message 
      };
    }
  }));

  results.forEach(result => {
    if (result.status === 'fulfilled') {
      const res = result.value;
      if (res.status === 'OK') {
        console.log(`[✓] ${res.name.padEnd(16)} | RUNNING | ${res.url}`);
      } else {
        console.log(`[✗] ${res.name.padEnd(16)} | DOWN    | ${res.error} | ${res.url}`);
      }
    } else {
      console.log(`[✗] Failed to process ${result.reason}`);
    }
  });
  
  console.log('\nFinished checking all sources.');
}

checkSources();
