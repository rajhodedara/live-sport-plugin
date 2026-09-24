const sharp = require('sharp');
const fs = require('fs');

async function run() {
  const svg = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="200" height="200" fill="red"/>
    <image href="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/128px-React-icon.svg.png" xlink:href="https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/128px-React-icon.svg.png" x="50" y="50" width="100" height="100"/>
  </svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync('test_ext.png', png);
  console.log('done, bytes:', png.length);
}
run();
