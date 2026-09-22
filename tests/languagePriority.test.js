'use strict';

// Unit tests for the configurable language-priority ranking used by
// handleStream. These drive the real service, so the assertions cannot drift
// from the shipped sort.
//
// The languages used here are the ones the channel detector actually emits
// (see ChannelCountryService): Spanish, Arabic, Hindi, German, French.

const {
  parseLanguagePriority,
  languageRank,
  compareStreams,
  streamRankScore,
  canonicalLanguage,
  isEnglish,
  DIRECT_STREAM_NAME
} = require('../src/services/LanguagePriorityService');

const direct = (overrides = {}) => ({
  name: DIRECT_STREAM_NAME,
  score: 50,
  speedScore: 50,
  ...overrides
});

describe('parseLanguagePriority', () => {
  it('returns [] when no config is supplied', () => {
    expect(parseLanguagePriority()).toEqual([]);
    expect(parseLanguagePriority({})).toEqual([]);
    expect(parseLanguagePriority(null)).toEqual([]);
  });

  it('parses a comma separated list in order, canonicalizing names', () => {
    expect(parseLanguagePriority({ languages: 'Spanish, Arabic' })).toEqual(['spanish', 'arabic']);
  });

  it('accepts ISO codes as well as names', () => {
    expect(parseLanguagePriority({ languages: 'es, ar, hi' })).toEqual(['spanish', 'arabic', 'hindi']);
  });

  it('is case-insensitive', () => {
    expect(parseLanguagePriority({ languages: 'ARABIC, spanish' })).toEqual(['arabic', 'spanish']);
  });

  it('drops English because it is always ranked first anyway', () => {
    expect(parseLanguagePriority({ languages: 'English, Arabic' })).toEqual(['arabic']);
  });

  it('ignores unknown tokens without throwing', () => {
    expect(parseLanguagePriority({ languages: 'Klingon, Spanish, xx' })).toEqual(['spanish']);
  });

  it('keeps only the first mention of a duplicate', () => {
    expect(parseLanguagePriority({ languages: 'Spanish, Arabic, es' })).toEqual(['spanish', 'arabic']);
  });

  it('tolerates malformed config without throwing', () => {
    expect(() => parseLanguagePriority({ languages: 42 })).not.toThrow();
    expect(parseLanguagePriority({ languages: 42 })).toEqual([]);
    expect(parseLanguagePriority({ languages: '' })).toEqual([]);
    expect(parseLanguagePriority({ languages: null })).toEqual([]);
    expect(parseLanguagePriority({ languages: undefined })).toEqual([]);
  });

  it('accepts a JSON array as well as a comma separated string', () => {
    expect(parseLanguagePriority({ languages: ['Arabic', 'Spanish'] })).toEqual(['arabic', 'spanish']);
  });
});

describe('languageRank', () => {
  it('ranks English 0 regardless of config', () => {
    expect(languageRank('English', [])).toBe(0);
    expect(languageRank('English', ['arabic'])).toBe(0);
    expect(languageRank('en', ['arabic'])).toBe(0);
  });

  it('ranks configured languages in the order given', () => {
    const p = parseLanguagePriority({ languages: 'Arabic, Spanish' });
    expect(languageRank('Arabic', p)).toBe(1);
    expect(languageRank('Spanish', p)).toBe(2);
  });

  it('keeps unknown below configured and above other-foreign', () => {
    const p = parseLanguagePriority({ languages: 'Arabic, Spanish' });
    expect(languageRank(undefined, p)).toBe(3);
    expect(languageRank('German', p)).toBe(4);
  });

  it('with no config reproduces the old English / unknown / other tiers', () => {
    expect(languageRank('English', [])).toBe(0);
    expect(languageRank(undefined, [])).toBe(1);
    expect(languageRank('German', [])).toBe(2);
  });
});

describe('compareStreams', () => {
  const p = parseLanguagePriority({ languages: 'Arabic, Spanish' });

  it('always puts English first, even against a configured language', () => {
    expect(compareStreams(direct({ language: 'English', score: 1 }), direct({ language: 'Arabic', score: 99 }), p)).toBeLessThan(0);
  });

  it('ranks a configured language above a higher-scored other language', () => {
    expect(compareStreams(direct({ language: 'Arabic', score: 10 }), direct({ language: 'German', score: 90 }), p)).toBeLessThan(0);
  });

  it('honours the configured order (first listed wins)', () => {
    expect(compareStreams(direct({ language: 'Arabic', score: 1 }), direct({ language: 'Spanish', score: 99 }), p)).toBeLessThan(0);
  });

  it('puts unknown language above other-foreign', () => {
    expect(compareStreams(direct({}), direct({ language: 'German', score: 99 }), p)).toBeLessThan(0);
  });

  it('a direct stream outranks a web fallback regardless of language', () => {
    const webEnglish = { name: 'Web Stream', language: 'English', score: 99, speedScore: 99 };
    expect(compareStreams(direct({ language: 'German', score: 1 }), webEnglish, p)).toBeLessThan(0);
  });

  it('breaks ties inside one rank by rankScore', () => {
    expect(compareStreams(
      direct({ language: 'English', score: 90, speedScore: 90 }),
      direct({ language: 'English', score: 40, speedScore: 40 }),
      p
    )).toBeLessThan(0);
  });

  it('sorts a mixed list into the documented order', () => {
    const list = [
      direct({ language: 'German' }),
      direct({}),
      direct({ language: 'English' }),
      direct({ language: 'Spanish' }),
      direct({ language: 'Arabic' })
    ];
    const order = [...list]
      .sort((a, b) => compareStreams(a, b, p))
      .map(s => s.language || '(unknown)');
    expect(order).toEqual(['English', 'Arabic', 'Spanish', '(unknown)', 'German']);
  });

  it('malformed streams never make the comparator throw', () => {
    expect(() => compareStreams(null, undefined, p)).not.toThrow();
    expect(() => compareStreams(null, undefined, null)).not.toThrow();
  });
});

describe('helpers', () => {
  it('canonicalLanguage folds names, codes and accents', () => {
    expect(canonicalLanguage('HI')).toBe('hindi');
    expect(canonicalLanguage('hindi')).toBe('hindi');
    expect(canonicalLanguage('')).toBe('');
    expect(canonicalLanguage(7)).toBe('');
  });

  it('isEnglish recognises the spellings of English', () => {
    expect(isEnglish('EN')).toBe(true);
    expect(isEnglish('English')).toBe(true);
    expect(isEnglish('German')).toBe(false);
  });

  it('streamRankScore is the documented blend', () => {
    expect(streamRankScore({ score: 100, speedScore: 0 })).toBe(80);
    expect(streamRankScore({ score: 0, speedScore: 100 })).toBe(20);
  });
});
