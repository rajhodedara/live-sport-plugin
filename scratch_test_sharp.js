const sharp = require('sharp');
const fs = require('fs');

async function test() {
  // A tiny red dot PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const dataUri = `data:image/png;base64,${b64}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
    <rect width="100" height="100" fill="#333" />
    <image href="${dataUri}" x="10" y="10" width="80" height="80" />
  </svg>`;
  
  try {
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    fs.writeFileSync('test_sharp_data_uri.png', buf);
    console.log('Success, bytes:', buf.length);
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
