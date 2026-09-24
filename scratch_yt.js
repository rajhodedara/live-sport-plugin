const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'TV_EMBEDDED'
  });

  const videoId = 'jfKfPfyJRdk'; // Lofi hip hop radio
  const info = await yt.getInfo(videoId);
  
  console.log("TV_EMBEDDED:");
  console.log("hlsManifestUrl:", info.streaming_data?.hls_manifest_url);
  console.log("dashManifestUrl:", info.streaming_data?.dash_manifest_url);

  const yt2 = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'IOS'
  });
  const info2 = await yt2.getInfo(videoId);
  console.log("IOS:");
  console.log("hlsManifestUrl:", info2.streaming_data?.hls_manifest_url);
  console.log("dashManifestUrl:", info2.streaming_data?.dash_manifest_url);
}
test().catch(console.error);
