const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const clients = ['WEB', 'IOS', 'ANDROID', 'TV_EMBEDDED', 'MWEB'];
  for (const clientType of clients) {
    try {
      const yt = await Innertube.create({
        cache: new UniversalCache(false),
        generate_session_locally: true,
        clientType
      });

      const videoId = 'aqz-KE-bpKQ'; 
      const info = await yt.getInfo(videoId);
      
      console.log(`\nClient: ${clientType}`);
      if (info.streaming_data) {
        console.log("hlsManifestUrl:", info.streaming_data.hls_manifest_url ? "YES" : "NO");
        const formats = info.streaming_data.formats || [];
        console.log("Formats URLs:", formats.map(f => f.url).filter(Boolean).length);
        if (formats.length > 0 && formats[0].url) {
             console.log("First format URL:", formats[0].url.substring(0, 100));
        }
      } else {
        console.log("No streaming_data");
      }
    } catch(e) {
      console.error(`Error with ${clientType}:`, e.message);
    }
  }
}
test().catch(console.error);
