const CdnLiveProvider = require('./src/providers/CdnLiveProvider');
const p = new CdnLiveProvider({
  circuitBreaker: {
    wrap: (name, fn) => fn
  }
});
p.resolveStream('ch:https://cdnlivetv.tv/api/v1/channels/player/?name=ESPN&code=us&user=cdnlivetv&plan=free')
  .then(res => {
    console.log(JSON.stringify(res, null, 2));
  })
  .catch(err => console.error(err));
