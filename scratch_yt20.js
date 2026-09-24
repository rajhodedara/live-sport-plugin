const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    clientType: 'ANDROID'
  });
  const info = await yt.getInfo('aqz-KE-bpKQ');
  
  if (info.streaming_data) {
    const formats = info.streaming_data.formats || [];
    console.log("ANDROID Formats:", formats.length);
    if (formats[0]) {
      console.log("URL:", formats[0].url);
      console.log("SignatureCipher:", formats[0].signature_cipher);
    }
  }
}
test().catch(console.error);
