const path1 = '/secure/TOKEN/nato/slug/1/MATCHID/';
const path2 = '/secure/TOKEN/1790067600/1790114400/darts1/';

const regex = /\/secure\/[^/]+\/([^/]+)\/[^/]+\/([^/]+)\//i;

console.log('path1:', path1.match(regex));
console.log('path2:', path2.match(regex));
