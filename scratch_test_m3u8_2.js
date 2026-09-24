const CdnLiveProvider = require('./src/providers/CdnLiveProvider');
const { safeFetch } = require('./src/impitClient');

const p = new CdnLiveProvider({
  circuitBreaker: {
    wrap: (name, fn) => fn
  }
});
p.resolveStream('ch:https://cdnlivetv.tv/api/v1/channels/player/?name=beIN%20SPORTS%201&code=us&user=cdnlivetv&plan=free')
  .then(async res => {
    const url = res[0].url;
    console.log('M3U8 URL:', url);
    const headers = res[0].behaviorHints.proxyHeaders.request;
    console.log('HEADERS:', headers);
    
    const fetchRes = await safeFetch(url, { headers });
    console.log('STATUS:', fetchRes.status);
    const text = await fetchRes.text();
    console.log('BODY:', text.slice(0, 500));
  })
  .catch(err => console.error(err));
