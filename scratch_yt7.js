const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'IOS'
  });

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    const formats = info.streaming_data.formats || [];
    console.log("IOS format url:");
    if (formats[0] && formats[0].url) {
      console.log(formats[0].url);
      console.log("Has ip parameter?", formats[0].url.includes('&ip=') || formats[0].url.includes('?ip='));
    }
  }
}
test().catch(console.error);
