const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const clients = ['WEB', 'ANDROID', 'IOS', 'TV_EMBEDDED'];
  for (const clientType of clients) {
    try {
      const yt = await Innertube.create({
        cache: new UniversalCache(false),
        clientType
      });

      const videoId = 'aqz-KE-bpKQ'; 
      const info = await yt.getInfo(videoId);
      
      const formats = info.streaming_data?.formats || [];
      const adaptive = info.streaming_data?.adaptive_formats || [];
      const all = [...formats, ...adaptive];
      
      if (all.length > 0) {
        try {
          const url = all[0].decipher(yt.session.player);
          console.log(`\nClient: ${clientType}`);
          console.log("URL contains /ip/:", url.includes('/ip/'));
          const res = await fetch(url, { method: 'HEAD' });
          console.log("Fetch status:", res.status);
        } catch (e) {
          console.log(`\nClient: ${clientType} (decipher fail)`);
        }
      }
    } catch (e) {
      console.log(`\nClient: ${clientType} - Error: ${e.message}`);
    }
  }
}
test().catch(console.error);
