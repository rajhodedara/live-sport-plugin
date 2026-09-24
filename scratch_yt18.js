const { Innertube } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create();
  const info = await yt.getInfo('aqz-KE-bpKQ');
  
  if (info.streaming_data) {
    const formats = info.streaming_data.formats || [];
    console.log("Formats count:", formats.length);
    if (formats[0]) {
      const url = formats[0].decipher(yt.session.player);
      console.log("Progressive URL:", url.substring(0, 150));
    }
  }
}
test().catch(console.error);
