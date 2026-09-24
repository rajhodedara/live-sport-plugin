const { request } = require('undici');
async function run() {
  const url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/128px-React-icon.svg.png';
  const res = await request(url, { headers: { 'User-Agent': 'Mozilla' } });
  const contentType = res.headers['content-type'];
  console.log(res.statusCode, contentType);
}
run();
