const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'TV_EMBEDDED'
  });

  const videoId = 'jNQXAC9IVRw'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    const formats = info.streaming_data.formats || [];
    console.log("TV_EMBEDDED Formats:");
    console.log(formats.map(f => f.url).filter(Boolean));
  }

  const yt2 = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'IOS'
  });

  const info2 = await yt2.getInfo(videoId);
  if (info2.streaming_data) {
    const formats = info2.streaming_data.formats || [];
    console.log("IOS Formats:");
    console.log(formats.map(f => f.url).filter(Boolean));
  }
}
test().catch(console.error);
