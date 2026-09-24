const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false)
  });

  const videoId = 'jNQXAC9IVRw'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data && info.streaming_data.formats && info.streaming_data.formats.length > 0) {
     const format = info.streaming_data.formats[0];
     const url = format.decipher(yt.session.player);
     console.log("Deciphered URL:", url.substring(0, 150) + "...");
  } else {
     console.log("No formats found");
  }
}
test().catch(console.error);
