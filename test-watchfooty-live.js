const { safeFetch } = require('./src/impitClient');

async function test() {
  const url = 'https://watchfooty.st/api/matches/all';
  try {
    const res = await safeFetch(url);
    const data = await res.json();
    const liveDarts = data.matches.filter(m => m.sport === 'darts' && m.status !== 'finished');
    console.log("Live/Pre Darts:", liveDarts.map(m => ({ title: m.title, status: m.status, streams: m.streams })));
  } catch(e) {
    console.error(e);
  }
}
test();
