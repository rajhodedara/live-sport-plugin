const { request } = require('undici');
async function run() {
  try {
    const url = 'https://r2.thesportsdb.com/images/media/team/badge/a5cjf41662659789.png'; // Al Fateh
    const res = await request(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    console.log(res.statusCode, res.headers['content-type']);
  } catch (e) {
    console.error(e);
  }
}
run();
