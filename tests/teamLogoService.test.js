const TeamLogoService = require('../src/services/TeamLogoService');
const MatchEntity = require('../src/domain/MatchEntity');
const container = require('../src/container');

describe('TeamLogoService', () => {
  let service;

  beforeEach(() => {
    service = new TeamLogoService();
  });

  describe('Curated & Alias Lookups (0ms)', () => {
    test('resolves direct curated team badges', () => {
      const arsenal = service.getCachedLogo('Arsenal');
      expect(arsenal).toContain('uyhbfe1612467038.png');

      const realMadrid = service.getCachedLogo('Real Madrid');
      expect(realMadrid).toContain('vwvwrw1473502969.png');

      const lakers = service.getCachedLogo('Los Angeles Lakers');
      expect(lakers).toContain('d8uoxw1714254511.png');
    });

    test('resolves team aliases cleanly', () => {
      const manUtd = service.getCachedLogo('Man Utd');
      expect(manUtd).toBeDefined();

      const barca = service.getCachedLogo('Barca');
      expect(barca).toContain('wq9sir1639406443.png');

      const psg = service.getCachedLogo('PSG');
      expect(psg).toContain('rwqrrq1473504808.png');
    });

    test('resolves league and tournament emblems', () => {
      expect(service.getLeagueLogo('Premier League')).toContain('23.png');
      expect(service.getLeagueLogo('UEFA Champions League')).toContain('2.png');
      expect(service.getLeagueLogo('Formula 1')).toContain('sky-sports-f1');
      expect(service.getLeagueLogo('', 'Formula 1 Grand Prix Baku', 'motorsport')).toContain('sky-sports-f1');
      expect(service.getLeagueLogo('NBA')).toContain('nba.png');
      expect(service.getLeagueLogo('UFC 306')).toContain('f8fdbx');
    });
  });

  describe('enrichMatch', () => {
    test('enriches match with team1 logo, team2 logo, and league logo', async () => {
      const match = new MatchEntity({
        id: 'test_match_1',
        title: 'Arsenal vs Chelsea',
        category: 'football',
        league: 'Premier League',
        team1: { name: 'Arsenal' },
        team2: { name: 'Chelsea' },
        sources: []
      });

      await service.enrichMatch(match);
      expect(match.team1.logo).toContain('uyhbfe1612467038.png');
      expect(match.team2.logo).toContain('yvwvtu1448813215.png');
      expect(match.logo).toBe(match.team1.logo);
    });

    test('enriches motorsport event with league emblem when teams absent', async () => {
      const match = new MatchEntity({
        id: 'test_f1',
        title: 'Grand Prix of Austria',
        category: 'motorsport',
        league: 'Formula 1',
        sources: []
      });

      await service.enrichMatch(match);
      expect(match.logo).toContain('sky-sports-f1');
    });
  });

  describe('Container Registration', () => {
    test('teamLogoService is registered as a singleton in Awilix container', () => {
      const resolved = container.resolve('teamLogoService');
      expect(resolved).toBeDefined();
      expect(typeof resolved.getCachedLogo).toBe('function');
      expect(typeof resolved.findTeamLogo).toBe('function');
    });
  });
});
