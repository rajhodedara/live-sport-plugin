const DaddyLiveProvider = require('./src/providers/DaddyLiveProvider');
const container = require('./src/container');

// Mock cache service for testing
container.register('cacheService', {
  get: async () => null,
  set: async () => {},
});

const provider = new DaddyLiveProvider();

async function run() {
  console.log("Resolving Stream 157...");
  const streams = await provider.resolveStream('157', 'DaddyLive', { proxyHeaders: { request: {} }});
  console.log(JSON.stringify(streams, null, 2));
}

run();
