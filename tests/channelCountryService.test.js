const ChannelCountryService = require('../src/services/ChannelCountryService');

describe('ChannelCountryService', () => {
  describe('detectChannelCountry', () => {
    test('accurately maps Israeli channels to Hebrew', () => {
      const ch1 = ChannelCountryService.detectChannelCountry('Sport 2 Israel');
      expect(ch1).toEqual({
        flag: '🇮🇱',
        name: 'IL',
        country: 'Israel',
        language: 'Hebrew'
      });

      const ch2 = ChannelCountryService.detectChannelCountry('Sport 5 Plus Israel');
      expect(ch2.language).toBe('Hebrew');
      expect(ch2.name).toBe('IL');
    });

    test('accurately maps UK channels to English', () => {
      const ch = ChannelCountryService.detectChannelCountry('Sky Sports Premier League UK');
      expect(ch).toEqual({
        flag: '🇬🇧',
        name: 'UK',
        country: 'United Kingdom',
        language: 'English'
      });
    });

    test('accurately maps US channels and distinguishes US Hispanic Spanish channels', () => {
      const usEng = ChannelCountryService.detectChannelCountry('NBC Sports Bay Area USA');
      expect(usEng.name).toBe('US');
      expect(usEng.language).toBe('English');

      const usSpan = ChannelCountryService.detectChannelCountry('Telemundo USA');
      expect(usSpan.name).toBe('US');
      expect(usSpan.language).toBe('Spanish');

      const tudn = ChannelCountryService.detectChannelCountry('TUDN USA');
      expect(tudn.language).toBe('Spanish');
    });

    test('accurately maps Dutch, German, French, Spanish, Italian, and Portuguese channels', () => {
      expect(ChannelCountryService.detectChannelCountry('ESPN 1 NL').language).toBe('Dutch');
      expect(ChannelCountryService.detectChannelCountry('Sportdigital FUSSBALL DE').language).toBe('German');
      expect(ChannelCountryService.detectChannelCountry('Canal+ Sport France').language).toBe('French');
      expect(ChannelCountryService.detectChannelCountry('Canal+ Sport360').language).toBe('French');
      expect(ChannelCountryService.detectChannelCountry('Movistar LaLiga Spain').language).toBe('Spanish');
      expect(ChannelCountryService.detectChannelCountry('Sky Sport Arena IT').language).toBe('Italian');
      expect(ChannelCountryService.detectChannelCountry('Sport TV1 Portugal').language).toBe('Portuguese');
      expect(ChannelCountryService.detectChannelCountry('SporTV Brazil').language).toBe('Portuguese');
    });

    test('accurately maps Balkan and Eastern European channels', () => {
      expect(ChannelCountryService.detectChannelCountry('Sport Klub 1 Serbia').language).toBe('Serbian');
      expect(ChannelCountryService.detectChannelCountry('Arena Sport 1 Croatia').language).toBe('Croatian');
      expect(ChannelCountryService.detectChannelCountry('arena sport 2 slovenia')).toEqual({
        flag: '🇸🇮',
        name: 'SI',
        country: 'Slovenia',
        language: 'Slovenian'
      });
      expect(ChannelCountryService.detectChannelCountry('TV 4 football')).toEqual({
        flag: '🇸🇪',
        name: 'SE',
        country: 'Sweden',
        language: 'Swedish'
      });
      expect(ChannelCountryService.detectChannelCountry('Diema Sport 2 Bulgaria').language).toBe('Bulgarian');
      expect(ChannelCountryService.detectChannelCountry('Polsat Sport 1 Poland').language).toBe('Polish');
      expect(ChannelCountryService.detectChannelCountry('Nova Sports 1 Greece').language).toBe('Greek');
      expect(ChannelCountryService.detectChannelCountry('TRT Spor Turkey').language).toBe('Turkish');
      expect(ChannelCountryService.detectChannelCountry('Digi Sport 1 Romania').language).toBe('Romanian');
      expect(ChannelCountryService.detectChannelCountry('Nova Sport 1 Czech').language).toBe('Czech');
      expect(ChannelCountryService.detectChannelCountry('M4 Sport Hungary').language).toBe('Hungarian');
    });

    test('accurately maps Canadian channels (English vs French)', () => {
      expect(ChannelCountryService.detectChannelCountry('TSN1').language).toBe('English');
      expect(ChannelCountryService.detectChannelCountry('Sportsnet Ontario').language).toBe('English');
      expect(ChannelCountryService.detectChannelCountry('RDS CA').language).toBe('French');
    });

    test('accurately maps MENA channels (Arabic vs English feeds)', () => {
      const ar = ChannelCountryService.detectChannelCountry('beIN Sports MENA 1');
      expect(ar.language).toBe('Arabic');

      const en = ChannelCountryService.detectChannelCountry('beIN Sports MENA English 1');
      expect(en.language).toBe('English');
    });

    test('accurately maps Malaysian and Southeast Asian channels', () => {
      const my1 = ChannelCountryService.detectChannelCountry('beIN Sports 3 Malaysia');
      expect(my1).toEqual({
        flag: '🇲🇾',
        name: 'MY',
        country: 'Malaysia',
        language: 'English'
      });

      const my2 = ChannelCountryService.detectChannelCountry('Astro Premier League');
      expect(my2.name).toBe('MY');
      expect(my2.language).toBe('English');

      const sg = ChannelCountryService.detectChannelCountry('Hub Premier');
      expect(sg).toEqual({
        flag: '🇸🇬',
        name: 'SG',
        country: 'Singapore',
        language: 'English'
      });
    });

    test('accurately maps German Bundesliga channels including Sky Port typo', () => {
      const de1 = ChannelCountryService.detectChannelCountry('Sky Sport Bundesliga');
      expect(de1).toEqual({
        flag: '🇩🇪',
        name: 'DE',
        country: 'Germany',
        language: 'German'
      });

      const de2 = ChannelCountryService.detectChannelCountry('Sky Port Bundesliga');
      expect(de2).toEqual({
        flag: '🇩🇪',
        name: 'DE',
        country: 'Germany',
        language: 'German'
      });

      const de3 = ChannelCountryService.detectChannelCountry('Sky Sport Bundesliga 1');
      expect(de3.language).toBe('German');
      expect(de3.name).toBe('DE');
    });
  });

  describe('formatCountryTag', () => {
    test('formats country tag with flag, country code and language', () => {
      expect(ChannelCountryService.formatCountryTag('Sport 2 Israel')).toBe(' 🇮🇱 [IL • Hebrew]');
      expect(ChannelCountryService.formatCountryTag('Sky Sports Main Event')).toBe(' 🇬🇧 [UK • English]');
      expect(ChannelCountryService.formatCountryTag('ESPN 1 NL')).toBe(' 🇳🇱 [NL • Dutch]');
      expect(ChannelCountryService.formatCountryTag('Diema Sport 2 Bulgaria')).toBe(' 🇧🇬 [BG • Bulgarian]');
    });

    test('returns empty string for null or unknown channels', () => {
      expect(ChannelCountryService.formatCountryTag(null)).toBe('');
      expect(ChannelCountryService.formatCountryTag('')).toBe('');
      expect(ChannelCountryService.formatCountryTag('RandomUnknownFeed12345')).toBe('');
    });
  });
});
