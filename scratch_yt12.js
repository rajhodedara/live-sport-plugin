const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    clientType: 'TV'
  });
  const info = await yt.getInfo('aqz-KE-bpKQ');
  console.log("TV HLS:", info.streaming_data?.hls_manifest_url);
  
  const yt2 = await Innertube.create({
    cache: new UniversalCache(false),
    clientType: 'TV_EMBEDDED' // Wait, try TVHTML5_SIMPLY_EMBEDDED_PLAYER ? youtubei.js accepts 'TV'
  });
  const info2 = await yt2.getInfo('aqz-KE-bpKQ');
  console.log("TV_EMBEDDED HLS:", info2.streaming_data?.hls_manifest_url);
}
test().catch(console.error);
