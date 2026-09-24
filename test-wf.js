fetch('https://api.watchfooty.st/api/v1/matches/all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
})
.then(res => res.json())
.then(data => {
  const withStreams = data.filter(i => Array.isArray(i.streams) && i.streams.length > 0);
  console.log(`Total: ${data.length}, With streams: ${withStreams.length}`);
  if (withStreams.length > 0) {
    console.log(JSON.stringify(withStreams[0], null, 2));
  } else {
    // maybe streams array exists but is named something else?
    console.log("No streams. Sample match keys:", Object.keys(data[0]));
    console.log("Sample:", JSON.stringify(data[0], null, 2));
  }
})
.catch(console.error);
