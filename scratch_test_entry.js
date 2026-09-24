const imageService = require('./src/services/ImageService');

async function run() {
  console.log('Fetching image...');
  const entry = await imageService.getImage('https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/128px-React-icon.svg.png');
  console.log('Entry:', entry ? entry.contentType : 'null');
  
  if (entry) {
    console.log('Converting...');
    try {
      if (entry.contentType !== 'image/png' && entry.contentType !== 'image/jpeg') {
        const sharp = require('sharp');
        entry.buffer = await sharp(entry.buffer).png().toBuffer();
        entry.contentType = 'image/png';
      }
      console.log('Done converting:', entry.contentType);
    } catch(e) {
      console.error(e);
    }
  }
  process.exit(0);
}
run();
