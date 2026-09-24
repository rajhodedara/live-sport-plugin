const sharp = require('sharp');
const fs = require('fs');

async function run() {
  const blueSquare = Buffer.from('UklGRjQAAABXRUJQVlA4ICgAAABQAgCdASoBAAEAL/3+/3+2AAwACAABWADA//+gAP//3AAAAAA=', 'base64');
  
  const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="200" height="200" fill="red"/>
    <image href="data:image/webp;base64,${blueSquare.toString('base64')}" xlink:href="data:image/webp;base64,${blueSquare.toString('base64')}" x="50" y="50" width="100" height="100"/>
  </svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync('test_webp.png', png);
  console.log('done, bytes:', png.length);
}
run();
