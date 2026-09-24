fetch('https://api.watchfooty.st/api/v1/matches/all', {
  headers: { 'User-Agent': 'Mozilla/5.0' }
})
.then(res => res.json())
.then(data => {
  const withStreams = data.filter(i => Array.isArray(i.streams) && i.streams.length > 0);
  const statuses = {};
  withStreams.forEach(m => {
    statuses[m.status] = (statuses[m.status] || 0) + 1;
  });
  console.log("Statuses of matches with streams:", statuses);
  
  const valid = withStreams.filter(m => !['post', 'post-final', 'postponed', 'cancelled'].includes(m.status));
  console.log("Valid for aggregator:", valid.length);
  if (valid.length > 0) {
    console.log("Sample valid match:", valid[0].matchId, valid[0].title);
  }
})
.catch(console.error);
