const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false)
  });

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    const adaptive = info.streaming_data.adaptive_formats || [];
    console.log("Format count:", adaptive.length);
    if (adaptive[0]) {
      try {
        const url = adaptive[0].decipher(yt.session.player);
        console.log("URL:", url.substring(0, 150));
        console.log("Has ip parameter?", url.includes('&ip=') || url.includes('?ip='));
      } catch (e) {
        console.log("Error deciphering", e);
      }
    }
  }
}
test().catch(console.error);
