const container = require('./src/container');

async function test() {
  const aggregator = container.resolve('matchAggregator');
  console.log("Aggregating...");
  await aggregator.aggregateMatches();
  
  const matches = aggregator.getMatches();
  const dartsMatch = matches.find(m => m.category === 'darts' && m.title.includes('Noppert'));
  if (!dartsMatch) {
      console.log("Darts match not found.");
      return;
  }
  
  console.log("Found match:", dartsMatch.title);
  const streams = await aggregator.getStreamsForEvent(dartsMatch.id, dartsMatch.category, dartsMatch.title);
  
  console.log("Streams:", JSON.stringify(streams.map(s => ({
      name: s.name,
      title: s.title,
      hasUrl: !!s.url,
      hasExternalUrl: !!s.externalUrl
  })), null, 2));
}

test().catch(console.error);
