const { Innertube } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create();

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    console.log("hlsManifestUrl:", info.streaming_data.hls_manifest_url);
    console.log("dashManifestUrl:", info.streaming_data.dash_manifest_url);
  }
}
test().catch(console.error);
