const container = require('./src/container');

async function test() {
  const aggregator = container.resolve('matchAggregator');
  const activeMatches = await aggregator.syncMatches();
  
  const dartsMatch = activeMatches.find(m => m.id === 'wf_faadc987331' || (m.category === 'darts' && m.title.includes('Noppert')));
  if (!dartsMatch) {
      console.log("Match not found");
      return;
  }
  console.log("Match:", dartsMatch.title);
  console.log("Sources:", dartsMatch.sources);
  
  const finalStreams = [];
  for (const src of dartsMatch.sources) {
      const providerName = src.source.replace(/^./, c => c.toLowerCase()) + 'Provider';
      const map = {
          watchfootyProvider: 'watchFootyProvider',
          embedindiaProvider: 'embedIndiaProvider',
          daddyliveProvider: 'daddyLiveProvider',
          timstreamsProvider: 'timStreamsProvider',
          cdnliveProvider: 'cdnLiveProvider',
          streamsports99Provider: 'streamSports99Provider'
      };
      const p = container.resolve(map[providerName] || providerName);
      if (p && p.resolveStream) {
          const s = await p.resolveStream(src.id, dartsMatch.category, dartsMatch.title, src);
          finalStreams.push(...s);
      }
  }
  
  console.log("Streams:", JSON.stringify(finalStreams, null, 2));
}

test().catch(console.error);
