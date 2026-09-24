const container = require('./src/container');
const TeamLogoService = require('./src/services/TeamLogoService');
const imageService = require('./src/services/ImageService');

const teamLogoService = new TeamLogoService();
container.register('teamLogoService', teamLogoService);

async function test() {
  const badge1 = await teamLogoService.findTeamLogo('Bahrain SC');
  console.log('Bahrain SC:', badge1);
}
test();
