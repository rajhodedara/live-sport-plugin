const { generateMatchCardSvg } = require('./src/services/MinimalistPosterService');
const fs = require('fs');
const sharp = require('sharp');

const b1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; // Dummy red dot
const b2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; // Dummy red dot

const svg = generateMatchCardSvg({
  team1: 'Al Shabab',
  team2: 'Al Fateh',
  badge1: b1,
  badge2: b2,
  status: 'live',
  shape: 'landscape'
});

fs.writeFileSync('test_match_card.svg', svg);
sharp(Buffer.from(svg)).png().toBuffer().then(buf => fs.writeFileSync('test_match_card.png', buf));
console.log('Done');
