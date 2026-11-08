'use strict';

const BroadcasterMatchService = require('../src/services/BroadcasterMatchService');
const MatchAggregator = require('../src/services/MatchAggregator');
const { selectSources } = require('../src/streams');

describe('BroadcasterMatchService', () => {
  let service;

  beforeAll(() => {
    service = new BroadcasterMatchService();
  });

  describe('Channel Resolution & Normalization', () => {
    test('resolves UK marquee sports channels', () => {
      const tnt1 = service.findChannel('TNT Sports 1');
      expect(tnt1).toBeDefined();
      expect(tnt1.name).toContain('TNT SPORT 1');
      expect(tnt1.group).toBe('United Kingdom');

      const skyPrem = service.findChannel('Sky Sports Premier League HD');
      expect(skyPrem).toBeDefined();
      expect(skyPrem.name).toContain('SKY SPORT PREMIER LEAGUE');
      expect(skyPrem.group).toBe('United Kingdom');
    });

    test('resolves legacy aliases and existing BT Sport channels', () => {
      const bt1 = service.findChannel('BT Sport 1');
      expect(bt1).toBeDefined();
      expect(bt1.name).toMatch(/BT SPORT 1|TNT SPORT 1/);
    });

    test('resolves Spanish marquee channels (Movistar / M+ / DAZN)', () => {
      const movistar = service.findChannel('Movistar LaLiga');
      expect(movistar).toBeDefined();
      expect(movistar.name).toContain('M+ LALIGA');
      expect(movistar.group).toBe('Spain');

      const dazn = service.findChannel('DAZN LaLiga');
      expect(dazn).toBeDefined();
      expect(dazn.name).toContain('DAZN LALIGA');
      expect(dazn.group).toBe('Spain');
    });

    test('resolves SuperSport marquee channels with group prioritization', () => {
      const ssPrem = service.findChannel('SuperSport Premier League');
      expect(ssPrem).toBeDefined();
      expect(ssPrem.name).toContain('SUPERSPORT 1');
      expect(ssPrem.group).toBe('United Kingdom');

      const ssFootball = service.findChannel('SuperSport Football');
      expect(ssFootball).toBeDefined();
      expect(ssFootball.name).toContain('SUPERSPORT 2');
      expect(ssFootball.group).toBe('United Kingdom');
    });

    test('handles diacritics, noisy tags, and special characters', () => {
      const noisy = service.findChannel('TNT SPORTS 1 (FHD / BACKUP) [UK]');
      expect(noisy).toBeDefined();
      expect(noisy.name).toContain('TNT SPORT 1');
    });

    test('returns null for empty, invalid, or unmapped names', () => {
      expect(service.findChannel('')).toBeNull();
      expect(service.findChannel(null)).toBeNull();
      expect(service.findChannel(undefined)).toBeNull();
      expect(service.findChannel('NonExistentChannel123456789')).toBeNull();
    });
  });

  describe('StreamSource Entity Generation', () => {
    test('creates valid Vavoo source entity for match fixtures', () => {
      const src = service.createVavooSource('Sky Sports Premier League');
      expect(src).toBeDefined();
      expect(src.source).toBe('vavoo');
      expect(src.id).toMatch(/^https:\/\/vavoo\.to\/vavoo-iptv\/play\//);
      expect(src.channelName).toBe('SKY SPORT PREMIER LEAGUE');
      expect(src.group).toBe('United Kingdom');
      expect(src.type).toBe('channel');
    });

    test('matchBroadcastersToVavooSources deduplicates identical channels', () => {
      const sources = service.matchBroadcastersToVavooSources([
        'TNT Sports 1',
        'TNT Sports 1 HD',
        'TNT SPORT 1 (FHD)',
        'Sky Sports Premier League'
      ]);
      expect(sources.length).toBe(2);
      expect(sources[0].channelName).toBe('TNT SPORT 1');
      expect(sources[1].channelName).toBe('SKY SPORT PREMIER LEAGUE');
    });
  });
});

describe('MatchAggregator Broadcaster Fixture Enrichment', () => {
  let aggregator;
  let broadcasterMatchService;

  beforeAll(() => {
    broadcasterMatchService = new BroadcasterMatchService();
    aggregator = new MatchAggregator({
      broadcasterMatchService,
      vavooProvider: { isEnabled: () => true }
    });
  });

  test('enriches live football match with matching Vavoo sources', () => {
    const liveMatch = {
      id: 'dlv_123_arsenal-chelsea',
      title: 'Arsenal vs Chelsea',
      category: 'football',
      sources: [
        { source: 'daddylive', id: '35', channelName: 'Sky Sports Premier League' },
        { source: 'daddylive', id: '40', channelName: 'TNT Sports 1' }
      ]
    };

    aggregator._enrichMatchesWithBroadcasters([liveMatch]);

    expect(liveMatch.sources.length).toBe(4);
    const vavooSources = liveMatch.sources.filter(s => s.source === 'vavoo');
    expect(vavooSources.length).toBe(2);
    expect(vavooSources[0].channelName).toBe('SKY SPORT PREMIER LEAGUE');
    expect(vavooSources[1].channelName).toBe('TNT SPORT 1');
  });

  test('prioritizes Canal+ Live event channels and suppresses linear Canal+ Sport', () => {
    const liveMatch = {
      id: 'dlv_999_como-vs-manchester-united',
      title: 'Como vs Manchester United',
      category: 'football',
      sources: [
        { source: 'daddylive', id: '32', channelName: 'TNT Sports 2 UK' },
        { source: 'daddylive', id: '122', channelName: 'Canal+ Sport France' },
        { source: 'daddylive', id: '55', channelName: 'Canal+ Live 3 France' },
        { source: 'daddylive', id: '984', channelName: 'Canal+ Extra 2 Poland' }
      ]
    };

    aggregator._enrichMatchesWithBroadcasters([liveMatch]);

    const vavooSources = liveMatch.sources.filter(s => s.source === 'vavoo');
    const channelNames = vavooSources.map(s => s.channelName);

    expect(channelNames).toContain('TNT SPORT 2');
    expect(channelNames).toContain('CANAL+ LIVE 3');
    expect(channelNames).toContain('CANAL+ EXTRA 2');
    expect(channelNames).not.toContain('CANAL SPORT');
  });

  test('does not enrich 24/7 channels or VOD replays', () => {
    const channelMatch = {
      id: 'vavoo_ch_123',
      title: 'Sky Sports Premier League',
      category: 'networks',
      sources: [{ source: 'daddylive', id: '35', channelName: 'Sky Sports Premier League' }]
    };

    const replayMatch = {
      id: 'rz_456_arsenal-chelsea',
      title: 'Arsenal vs Chelsea Full Replay',
      category: 'football',
      isReplay: true,
      sources: [{ source: 'replayzone', id: '1', channelName: 'Sky Sports Premier League' }]
    };

    aggregator._enrichMatchesWithBroadcasters([channelMatch, replayMatch]);

    expect(channelMatch.sources.length).toBe(1);
    expect(replayMatch.sources.length).toBe(1);
  });

  test('respects VAVOO_ENABLED toggle', () => {
    const disabledAggregator = new MatchAggregator({
      broadcasterMatchService,
      vavooProvider: { isEnabled: () => false }
    });

    const liveMatch = {
      id: 'dlv_789_madrid-barca',
      title: 'Real Madrid vs Barcelona',
      category: 'football',
      sources: [{ source: 'daddylive', id: '50', channelName: 'Movistar LaLiga' }]
    };

    disabledAggregator._enrichMatchesWithBroadcasters([liveMatch]);
    expect(liveMatch.sources.length).toBe(1);
    expect(liveMatch.sources[0].source).toBe('daddylive');
  });
});

describe('Stream Source Priority Integration', () => {
  test('selectSources ranks timstreams (P2) > DaddyLive (P5) > Vavoo (P6) > secondary sources', () => {
    const sources = [
      { source: 'streamsports99', id: '3' },
      { source: 'daddylive', id: '2' },
      { source: 'vavoo', id: '1' },
      { source: 'timstreams', id: '4' }
    ];

    const selected = selectSources(sources, null);
    expect(selected[0].source).toBe('timstreams');
    expect(selected[1].source).toBe('daddylive');
    expect(selected[2].source).toBe('vavoo');
    expect(selected[3].source).toBe('streamsports99');
  });
});
