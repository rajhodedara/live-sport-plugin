const { getCfImageWorker } = require('./src/services/HlsRewriteService');

async function test() {
  const url = 'https://p16-common-sign.tiktokcdn-eu.com/tos-no1a-i-50187-no/a9ac52e901527443b4050cb42f73bb62~tplv-tiktokx-origin.image?dr=10395&refresh_token=874a432d&x-expires=1790110800&x-signature=CGMOU9LExjhgFi5fgSgh5mz8Iec%3D&t=4d5b0474&ps=13740610&shp=f21f527a&shcp=9b759fb9&idc=no1a';
  const referer = 'https://embedindia.st/';
  const origin = 'https://embedindia.st';
  
  const worker = getCfImageWorker();
  const target = `${worker}/?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}`;
  console.log("Fetching from worker:", worker);
  try {
    const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
    const res = await fetch(target, { timeout: 10000 });
    console.log("Status:", res.status);
    const body = await res.arrayBuffer();
    const buf = Buffer.from(body);
    console.log("Body length:", buf.length);
    console.log("First byte (should be 0x47 / 71):", buf[0]);
  } catch (e) {
    console.error("Error:", e);
  }
}

test();
