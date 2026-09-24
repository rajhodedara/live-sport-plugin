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
    console.log("IOS Formats:", formats.length);
    if (formats[0]) {
      console.log("URL:", formats[0].url.substring(0, 150));
      console.log("Has ip parameter?", formats[0].url.includes('&ip=') || formats[0].url.includes('?ip='));
    }
  }
}
test().catch(console.error);
