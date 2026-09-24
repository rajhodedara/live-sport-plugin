const express = require('express');
const streamsRoute = require('./src/routes/streams');
const container = require('./src/container');

async function test() {
  const aggregator = container.resolve('matchAggregator');
  await aggregator.aggregateMatches(); // Make sure matches are loaded
  
  const req = { params: { type: 'darts', id: 'wf_faadc987331.json' } };
  const res = {
    setHeader: () => {},
    json: (data) => {
      console.log("Stremio streams response:", JSON.stringify(data.streams.map(s => ({ title: s.title, url: !!s.url, externalUrl: !!s.externalUrl })), null, 2));
    },
    status: (code) => ({ send: console.log })
  };
  
  // Directly invoke the resolver logic from streamsRoute if we can, or just call getStreamsForEvent
  // Wait, Nuvio handles `wf_faadc987331` by calling aggregator.getStreamsForEvent('wf_faadc987331', 'darts', title)
  
  const matches = aggregator.getMatches();
  const match = matches.find(m => m.id === 'wf_faadc987331');
  if (!match) {
      console.log("Match not found in aggregator");
      return;
  }
  
  const streams = await aggregator.getStreamsForEvent(match.id, match.category, match.title);
  console.log(JSON.stringify(streams.map(s => ({ name: s.name, title: s.title, url: s.url ? s.url.substring(0, 30) : null, externalUrl: !!s.externalUrl })), null, 2));
}

test().catch(console.error);
