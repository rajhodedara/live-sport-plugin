'use strict';

const {
  normalizeName,
  channelKey,
  channelAliasKey,
  teamChannelKeys,
  teamQueryKeys,
  eventQueryTokens,
  classifyChannelKind,
  entryScore,
  qualityScore,
  groupScore
} = require('../src/services/TrexCatalogKeys');

describe('TrexCatalogKeys', () => {
  describe('normalizeName', () => {
    test('strips diacritics, lowercases and drops everything that is not a-z0-9', () => {
      expect(normalizeName('Atlético de Madrid ᴿᴬᵂ')).toBe('atletico de madrid');
    });
  });

  describe('channelKey / channelAliasKey', () => {
    test('drops the group token and the quality tokens', () => {
      expect(channelKey('UK| SKY SPORTS CRICKET FHD')).toBe('sky sport cricket');
    });

    test('folds sports to sport in every token', () => {
      expect(channelKey('US| CHICAGO SPORTS NETWORK HD')).toBe('chicago sport network');
    });

    test('keeps a trailing qualifier in the exact key and drops it in the alias', () => {
      expect(channelKey('UK| BEIN SPORTS 1 PREMIUM HD')).toBe('bein sport 1 premium');
      expect(channelAliasKey('UK| BEIN SPORTS 1 PREMIUM HD')).toBe('bein sport 1');
    });

    test('has no alias when the key does not end in a qualifier', () => {
      expect(channelAliasKey('UK| SKY SPORTS CRICKET HD')).toBe('');
    });
  });

  describe('teamChannelKeys', () => {
    test('emits a two-token club in both orders', () => {
      expect(teamChannelKeys('NBA TEAM| CHICAGO BULLS')).toEqual({
        league: 'nba',
        keys: ['chicago bulls', 'bulls chicago']
      });
    });

    test('drops the bracketed code of an AHL club', () => {
      expect(teamChannelKeys('AHL-TEAM| CHICAGO WOLVES [CHI]').keys).toContain('chicago wolves');
    });

    test('drops the leading network and the trailing state code', () => {
      expect(teamChannelKeys('NFL TEAMS| CBS BEARS CHICAGO IL').keys).toEqual(['bears chicago', 'chicago bears']);
    });

    test('expands a combined entry whose multi-word city ends the list', () => {
      expect(teamChannelKeys('NFL TEAMS| CBS BILLS GIANTS JETS NEW YORK NY').keys).toEqual([
        'new york bills',
        'new york giants',
        'new york jets'
      ]);
    });

    test('detects a multi-word city that starts the list', () => {
      expect(teamChannelKeys('NBA TEAM| NEW YORK KNICKS').keys).toEqual(['new york knicks']);
    });

    test('drops club fillers', () => {
      expect(teamChannelKeys('LA LIGA| AC MILAN').keys).toEqual(['milan']);
    });

    test('recognizes MLB clubs that carry no team group', () => {
      expect(teamChannelKeys('US| MLB CHICAGO CUBS HD')).toEqual({
        league: 'mlb',
        keys: ['chicago cubs', 'cubs chicago']
      });
    });

    test('is null for a channel that is not a team channel', () => {
      expect(teamChannelKeys('UK| SKY SPORTS CRICKET HD')).toBeNull();
    });
  });

  describe('teamQueryKeys / eventQueryTokens', () => {
    test('drops club fillers from fixture names', () => {
      expect(teamQueryKeys('Atlético de Madrid')).toContain('atletico madrid');
      expect(teamQueryKeys('Valencia CF')).toEqual(['valencia']);
    });

    test('emits a multi-token fixture name in both orders', () => {
      expect(teamQueryKeys('East Carolina Pirates')).toEqual(['east carolina pirates', 'pirates east carolina']);
    });

    test('detects a multi-word city on the fixture side as well', () => {
      expect(teamQueryKeys('New York Giants')).toEqual(['new york giants']);
    });

    test('takes the first three cleaned tokens for the event search', () => {
      expect(eventQueryTokens('East Carolina Pirates')).toEqual(['east', 'carolina', 'pirates']);
      expect(eventQueryTokens('Atlético de Madrid')).toEqual(['atletico', 'madrid']);
    });
  });

  describe('classifyChannelKind', () => {
    test.each([
      ['NBA TEAM| CHICAGO BULLS', 'team'],
      ['NEXT | CHI - BULLS VS CLE - CAVALIERS | Mon 23 Nov 19:00 EST (US) | 8K EXCLUSIVE | US: NBA PASS PPV 6', 'event'],
      ['US (ESPN+ 073) | NCAA Women`s Basketball: Wofford vs. Wake Forest (Wofford vs. Wake Forest) (2026-11-23 18:00:40)', 'event'],
      ['NO EVENT STREAMING NOW -| Box Office', 'placeholder'],
      ['CA| WILLOW CRICKET HD', 'linear'],
      ['JOYN| 3SAT ᴿᴬᵂ', 'other']
    ])('classifies %s as %s', (name, kind) => {
      expect(classifyChannelKind(name)).toBe(kind);
    });

    test.each([
      ['Live | NHL: NY RANGERS - WINNIPEG'],
      ['End | F1: GRAND PRIX'],
      ['ENDED | UFC FIGHT NIGHT'],
      ['end | Premier League: Arsenal - Chelsea']
    ])('classifies the event prefix of %s', (name) => {
      expect(classifyChannelKind(name)).toBe('event');
    });

    test('needs the timestamp next to vs', () => {
      expect(classifyChannelKind('US| NBC SPORTS VS NETWORK HD')).toBe('linear');
    });
  });

  describe('scoring', () => {
    test('ranks quality first, then the group', () => {
      expect(entryScore('UK| SKY SPORTS CRICKET FHD', 'UK')).toBeGreaterThan(entryScore('IE| SKY SPORTS CRICKET HD', 'IE'));
      expect(entryScore('IE| SKY SPORTS CRICKET HD', 'IE')).toBeGreaterThan(entryScore('XX| SKY SPORTS CRICKET', 'XX'));
    });

    test('is qualityScore * 1000 + groupScore', () => {
      expect(entryScore('IE| SKY SPORTS CRICKET HD', 'IE')).toBe(qualityScore('IE| SKY SPORTS CRICKET HD') * 1000 + groupScore('IE'));
    });

    test('reads the group from its first token (US (ESPN+ 073), UK-NOWTV)', () => {
      expect(groupScore('US (ESPN+ 073)')).toBe(groupScore('US'));
      expect(groupScore('uk-nowtv')).toBe(groupScore('UK'));
      expect(groupScore('XX')).toBe(0);
    });

    test('orders 8K above 4K/UHD, FHD, HD, plain and SD', () => {
      expect(qualityScore('X 8K')).toBeGreaterThan(qualityScore('X 4K'));
      expect(qualityScore('X 4K')).toBe(qualityScore('X UHD'));
      expect(qualityScore('X 4K')).toBeGreaterThan(qualityScore('X FHD'));
      expect(qualityScore('X FHD')).toBeGreaterThan(qualityScore('X HD'));
      expect(qualityScore('X HD')).toBeGreaterThan(qualityScore('X'));
      expect(qualityScore('X')).toBeGreaterThan(qualityScore('X SD'));
    });
  });
});
