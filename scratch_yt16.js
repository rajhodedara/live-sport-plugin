const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'WEB',
    fetch: async (input, init) => {
       const headers = new Headers(init?.headers);
       headers.set('X-Forwarded-For', '8.8.8.8');
       headers.set('X-Real-IP', '8.8.8.8');
       return fetch(input, { ...init, headers });
    }
  });

  const videoId = 'aqz-KE-bpKQ'; 
  const info = await yt.getInfo(videoId);
  
  if (info.streaming_data) {
    const formats = info.streaming_data.adaptive_formats || [];
    if (formats[0]) {
      try {
        const url = formats[0].decipher(yt.session.player);
        console.log(url.substring(0, 150));
        console.log("Has 8.8.8.8?", url.includes('8.8.8.8'));
      } catch (e) {
        console.log("decipher fail");
      }
    }
  }
}
test().catch(console.error);
