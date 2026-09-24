const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'IOS'
  });

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  console.log("has streaming_data:", !!info.streaming_data);
  if (info.streaming_data) {
    const formats = info.streaming_data.formats || [];
    const adaptive = info.streaming_data.adaptive_formats || [];
    console.log("Formats URLs:", formats.map(f => f.url).filter(Boolean).length);
    console.log("Adaptive URLs:", adaptive.map(f => f.url).filter(Boolean).length);
    console.log("hlsManifestUrl:", info.streaming_data.hls_manifest_url);
    if (info.streaming_data.hls_manifest_url) {
      console.log("Found HLS:", info.streaming_data.hls_manifest_url.substring(0, 50) + "...");
    }
  }
}
test().catch(console.error);
