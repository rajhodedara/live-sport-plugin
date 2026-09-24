const { safeFetch } = require('./src/impitClient');

async function test() {
  const directUrl = 'https://p16-common-sign.tiktokcdn-eu.com/tos-no1a-i-5300-no/85c4a7b975032e8d23348ed8d786fa7d~tplv-tiktokx-origin.image?dr=10395&refresh_token=1108a9e1&x-expires=1790110800&x-signature=gReqNTL%2FuWJ6K85U0ArTYLP%2BeJI%3D&t=4d5b0474&ps=13740610&shp=f21f527a&shcp=9b759fb9&idc=no1a';
  
  const cfWorkerUrl = 'https://nuvio-proxy.odedararaj456.workers.dev/?url=' + encodeURIComponent(directUrl) + '&referer=https://embedindia.st/&origin=https://embedindia.st';

  console.log("Fetching direct...");
  try {
    let res = await safeFetch(directUrl, { headers: { referer: 'https://embedindia.st/' }});
    console.log("Direct status:", res.status);
  } catch (e) {
    console.log("Direct error:", e.message);
  }

  console.log("Fetching via CF Worker...");
  try {
    let res2 = await safeFetch(cfWorkerUrl);
    console.log("CF Worker status:", res2.status);
    let h = res2.headers.get('content-type');
    console.log("CF Worker type:", h);
    let bytes = await res2.arrayBuffer();
    console.log("CF Worker length:", bytes.byteLength);
  } catch (e) {
    console.log("CF worker error:", e.message);
  }
}

test();
