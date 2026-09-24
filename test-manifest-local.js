const express = require('express');
const manifestRoute = require('./src/routes/manifest');

const app = express();
app.use('/', manifestRoute);

async function test() {
  const server = app.listen(8080, async () => {
    try {
      const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
      const url = encodeURIComponent('https://netanyahu.indianservers.st/secure/omNaLhsgsDOaRUuiyFMKgPTjIbHboXYq/1790067600/1790114400/darts1/index.m3u8');
      const res = await fetch(`http://localhost:8080/api/manifest?url=${url}&referer=${encodeURIComponent('https://embedindia.st/')}&origin=${encodeURIComponent('https://embedindia.st')}`);
      console.log("Status:", res.status);
      console.log("Headers:", Array.from(res.headers.entries()));
      const text = await res.text();
      console.log("Body start:", text.substring(0, 500));
    } finally {
      server.close();
    }
  });
}

test();
