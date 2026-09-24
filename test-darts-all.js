const container = require('./src/container');

async function test() {
  const aggregator = container.resolve('matchAggregator');
  const matches = await aggregator.syncMatches();
  
  const darts = matches.filter(m => m.category === 'darts');
  console.log(`Found ${darts.length} darts matches.`);
  
  for (const m of darts) {
      console.log(`\nMatch: ${m.title}`);
      for (const src of m.sources) {
          if (src.source === 'watchfooty') {
              const p = container.resolve('watchFootyProvider');
              try {
                  const s = await p.resolveStream(src.id, m.category, m.title, src);
                  console.log(`  WatchFooty: ${JSON.stringify(s.map(x => ({ name: x.name, title: x.title, hasUrl: !!x.url, hasExternal: !!x.externalUrl })), null, 2)}`);
              } catch (e) {
                  console.log(`  WatchFooty Error: ${e.message}`);
              }
          }
      }
  }
}

test().catch(console.error);
