const { mergeRemintedUrl } = require('./src/remint');

const heldUrl = 'https://shiva.indianservers.st/secure/OLD_TOKEN/1790067600/1790114400/darts1/1/index.m3u8';
const freshUrl = 'https://vishnu.indianservers.st/secure/NEW_TOKEN/1790067600/1790114400/darts1/index.m3u8';
const rck = 'embedindia:123:456';

console.log(mergeRemintedUrl(heldUrl, freshUrl, rck));
