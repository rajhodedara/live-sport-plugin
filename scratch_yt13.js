const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    clientType: 'IOS'
  });
  const info = await yt.getInfo('aqz-KE-bpKQ');
  const dash = info.toDash((url) => {
     return url; // modify url
  });
  console.log(dash.substring(0, 1000));
}
test().catch(console.error);
