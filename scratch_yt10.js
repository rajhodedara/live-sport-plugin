const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false)
  });

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    const adaptive = info.streaming_data.adaptive_formats || [];
    if (adaptive[0]) {
      console.log(Object.keys(adaptive[0]));
      console.log("has url:", !!adaptive[0].url);
      console.log("has signature_cipher:", !!adaptive[0].signature_cipher);
      console.log("has cipher:", !!adaptive[0].cipher);
    }
  }
}
test().catch(console.error);
