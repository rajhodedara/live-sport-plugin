const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'TV_EMBEDDED'
  });

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    const adaptive = info.streaming_data.adaptive_formats || [];
    console.log("TV_EMBEDDED format count:", adaptive.length);
    if (adaptive[0] && adaptive[0].url) {
      console.log(adaptive[0].url.substring(0, 150));
      console.log("Has ip parameter?", adaptive[0].url.includes('&ip=') || adaptive[0].url.includes('?ip='));
    }
  }
}
test().catch(console.error);
