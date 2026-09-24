const container = require('./src/container');

async function test() {
  const provider = container.resolve('watchFootyProvider');
  console.log("Resolving stream...");
  const streams = await provider.resolveStream('faadc987331', 'darts', 'Noppert D. vs de Graaf J.');
  console.log("Streams:", JSON.stringify(streams, null, 2));
}

test().catch(console.error);
