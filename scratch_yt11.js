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
      console.log(JSON.stringify(adaptive[0], null, 2));
    }
  }
}
test().catch(console.error);
