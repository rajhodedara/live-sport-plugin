const container = require('./src/container');
const TeamLogoService = require('./src/services/TeamLogoService');
const imageService = require('./src/services/ImageService');

const teamLogoService = new TeamLogoService();
container.register('teamLogoService', teamLogoService);

async function test() {
  const badge1 = await teamLogoService.findTeamLogo('Al Shabab');
  const badge2 = await teamLogoService.findTeamLogo('Al Fateh');
  
  console.log('Al Shabab:', badge1);
  console.log('Al Fateh:', badge2);
}
test();
