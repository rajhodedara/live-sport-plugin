const { Innertube, UniversalCache } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    clientType: 'IOS',
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
    const formats = info.streaming_data.formats || [];
    console.log(formats.map(f => f.url).filter(Boolean));
  }
}
test().catch(console.error);
