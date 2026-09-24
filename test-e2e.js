const DamiTvProvider = require('./src/providers/DamiTvProvider');
const { safeFetch } = require('./src/impitClient');

(async () => {
  try {
    const prov = new DamiTvProvider({ circuitBreaker: { wrap: (name, fn) => fn } });
    console.log('[1] Resolving stream for manual-japan-vs-uruguay...');
    const streams = await prov.resolveStream('manual-japan-vs-uruguay', 'football', 'Japan vs Uruguay', {url: 'https://damitv.st/embed/?id=manual-japan-vs-uruguay'});
    
    if (!streams || streams.length === 0) {
      console.log('Failed to extract streams');
      process.exit(1);
    }
    
    console.log('[2] Extracted Stream:', streams[0]);
    
    if (streams[0].url) {
      console.log(`\n[3] Testing Proxy Route: ${streams[0].url}`);
      
      const urlObj = new URL(streams[0].url);
      const upstream = urlObj.searchParams.get('url');
      const referer = urlObj.searchParams.get('referer');
      
      console.log(`\n[4] Testing Upstream Route directly: ${upstream}`);
      const res = await safeFetch(upstream, {
        headers: { 'Referer': referer, 'User-Agent': 'Mozilla/5.0' },
        timeoutMs: 10000
      });
      console.log(`Upstream Status: ${res.status}`);
      const text = await res.text();
      console.log(`Upstream M3U8 Head:\n${text.substring(0, 300)}`);
      if (text.includes('#EXTM3U')) {
         console.log('\n✅ END-TO-END SUCCESS: Valid M3U8 payload received.');
      } else {
         console.log('\n❌ END-TO-END FAILED: Invalid M3U8 payload.');
      }
    }
  } catch (err) {
    console.error(err);
  }
})();
