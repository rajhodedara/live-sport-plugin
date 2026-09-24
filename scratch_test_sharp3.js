const sharp = require('sharp');
const fs = require('fs');

async function test() {
  // inner SVG with viewBox but NO width/height
  const innerSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><circle cx="25" cy="25" r="25" fill="red" /></svg>`;
  const b64 = Buffer.from(innerSvg).toString('base64');
  const dataUri = `data:image/svg+xml;base64,${b64}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <rect width="100" height="100" fill="#333" />
    <image href="${dataUri}" x="10" y="10" width="80" height="80" />
  </svg>`;
  
  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync('test_sharp_svg_data_uri_nowh.png', buf);
    console.log('Success, bytes:', buf.length);
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
