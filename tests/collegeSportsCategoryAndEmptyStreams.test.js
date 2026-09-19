const BaseProvider = require('../src/providers/BaseProvider');
const StreamSports99Provider = require('../src/providers/StreamSports99Provider');
const CdnLiveProvider = require('../src/providers/CdnLiveProvider');
const DaddyLiveProvider = require('../src/providers/DaddyLiveProvider');
const MatchAggregator = require('../src/services/MatchAggregator');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

describe('College Sports Categorization and Empty Stream Guards', () => {
  let circuitBreaker;

  beforeEach(() => {
    circuitBreaker = new CircuitBreakerService();
  });

  describe('BaseProvider.normalizeCategory', () => {
    const base = new BaseProvider({ circuitBreaker });

    test('normalizes NCAA and College football correctly to college', () => {
      expect(base.normalizeCategory('College Football')).toBe('college');
      expect(base.normalizeCategory('NCAA Football')).toBe('college');
      expect(base.normalizeCategory('College High School Football')).toBe('college');
      expect(base.normalizeCategory('NCAA Basketball')).toBe('college');
      expect(base.normalizeCategory('ncaa')).toBe('college');
      expect(base.normalizeCategory('college')).toBe('college');
    });

    test('preserves regular soccer and american football categories', () => {
      expect(base.normalizeCategory('American Football')).toBe('american_football');
      expect(base.normalizeCategory('NFL')).toBe('american_football');
      expect(base.normalizeCategory('Football')).toBe('football');
      expect(base.normalizeCategory('Soccer')).toBe('football');
      expect(base.normalizeCategory('Premier League Football')).toBe('football');
    });
  });

  describe('StreamSports99Provider empty channels filter', () => {
    test('skips events where channels is empty or missing', async () => {
      const provider = new StreamSports99Provider({ circuitBreaker });
      provider.fetchMain = {
        fire: jest.fn().mockResolvedValue({
          'cdn-live-tv': {
            'NCAA': [
              {
                gameID: 'empty_event_1',
                name: 'Texas Tech vs Houston',
                channels: []
              },
              {
                gameID: 'empty_event_2',
                name: 'Wake Forest vs Miami',
                channels: null
              },
              {
                gameID: 'valid_event_1',
                name: 'Ohio State vs Michigan',
                channels: [{ channel_name: 'ESPN', channel_id: '123' }]
              }
            ]
          }
        })
      };

      const matches = await provider.getMatches();
      expect(matches).toHaveLength(1);
      expect(matches[0].title).toBe('Ohio State vs Michigan');
      expect(matches[0].category).toBe('college');
    });
  });

  describe('CdnLiveProvider empty channels filter', () => {
    test('skips events where channels is empty or missing', async () => {
      const provider = new CdnLiveProvider({ circuitBreaker });
      provider.fetchMain = {
        fire: jest.fn().mockResolvedValue({
          'cdn-live-tv': {
            'Soccer': [
              {
                gameID: 'empty_soccer_1',
                homeTeam: 'Team A',
                awayTeam: 'Team B',
                channels: []
              },
              {
                gameID: 'valid_soccer_1',
                homeTeam: 'Arsenal',
                awayTeam: 'Chelsea',
                channels: [{ channel_name: 'Sky Sports', player_url: 'https://example.com' }]
              }
            ]
          }
        })
      };

      const matches = await provider.getEventMatches();
      expect(matches).toHaveLength(1);
      expect(matches[0].title).toBe('Arsenal vs Chelsea');
    });
  });

  describe('DaddyLiveProvider college detection', () => {
    test('categorizes College High School Football events as college', async () => {
      const provider = new DaddyLiveProvider({ circuitBreaker });
      provider.fetchChannels = { fire: jest.fn().mockResolvedValue([]) };
      const futureDate = new Date(Date.now() + 86400000 * 2);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const header = `Day ${futureDate.getUTCDate()}th ${months[futureDate.getUTCMonth()]} ${futureDate.getUTCFullYear()} - Schedule Time UK GMT`;
      provider.fetchSchedule = {
        fire: jest.fn().mockResolvedValue({
          [header]: {
            'High School Football': [
              {
                time: '23:30',
                event: 'College High School Football : Miami vs Wake Forest',
                channels: [{ channel_name: 'ESPN USA', channel_id: '44' }]
              },
              {
                time: '23:30',
                event: 'College High School Football : Houston vs Texas Tech',
                channels: [{ channel_name: 'FOX USA', channel_id: '54' }]
              }
            ]
          }
        })
      };

      const matches = await provider.getMatches();
      const collegeMatches = matches.filter(m => m.category === 'college');
      expect(collegeMatches).toHaveLength(2);
      expect(collegeMatches[0].title).toBe('Miami vs Wake Forest');
      expect(collegeMatches[1].title).toBe('Houston vs Texas Tech');
    });
  });

  describe('MatchAggregator cross-category merging for college', () => {
    test('merges college and football/american_football if dual teams match and keeps college category', () => {
      const aggregator = new MatchAggregator({ providers: [], cacheService: { set: jest.fn() } });
      const p1 = aggregator._precompute({
        id: 'ss99_123',
        title: 'Miami vs Wake Forest',
        category: 'college'
      });
      const p2 = aggregator._precompute({
        id: 'dlive_456',
        title: 'Miami vs Wake Forest',
        category: 'football'
      });

      expect(aggregator._sameEventPre(p1, p2)).toBe(true);
    });
  });
});
