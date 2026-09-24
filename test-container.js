const container = require('./src/container');
async function test() {
  const provider = container.resolve('watchFootyProvider');
  const matches = await provider.getMatches();
  console.log(`Provider returned ${matches.length} matches.`);
  if (matches.length > 0) {
    console.log("Sample:", JSON.stringify(matches[0], null, 2));
  }
}
test().catch(console.error);
