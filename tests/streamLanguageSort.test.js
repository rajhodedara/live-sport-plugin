'use strict';

// Unit tests for the language-tier sort applied by handleStream.
//
// These previously re-implemented the comparator inline, which meant they could
// pass while the shipped sort diverged. They now import the real
// LanguagePriorityService comparator. No config is supplied, so the ordering
// under test is the original English -> unknown -> other-known-language
// behaviour, together with the direct-beats-web and rankScore rules.

const {
  parseLanguagePriority,
  compareStreams,
  streamRankScore,
  DIRECT_STREAM_NAME
} = require('../src/services/LanguagePriorityService');

const NO_CONFIG = parseLanguagePriority({});

function sortStreams(streams) {
  return [...streams].sort((a, b) => compareStreams(a, b, NO_CONFIG));
}

const rankScore = streamRankScore;

const direct = (overrides = {}) => ({
  name: DIRECT_STREAM_NAME,
  score: 50,
  speedScore: 50,
  ...overrides
});

describe('stream language-tier sort', () => {
  it('English outranks German when score and speedScore are equal', () => {
    const english = direct({ language: 'English' });
    const german  = direct({ language: 'German' });

    const result = sortStreams([german, english]);

    expect(result[0].language).toBe('English');
    expect(result[1].language).toBe('German');
  });

  it('unknown-language sits between English and German (tier 0 < 1 < 2)', () => {
    const english = direct({ language: 'English' });
    const unknown = direct({ /* no language property */ });
    const german  = direct({ language: 'German' });

    const result = sortStreams([german, unknown, english]);

    expect(result[0].language).toBe('English');
    expect(result[1].language).toBeUndefined();
    expect(result[2].language).toBe('German');
  });

  it('direct stream always beats a web stream regardless of language tier', () => {
    const webEnglish   = { name: 'Web Stream', language: 'English', score: 99, speedScore: 99 };
    const directGerman = { name: DIRECT_STREAM_NAME, language: 'German', score: 1, speedScore: 1 };

    const result = sortStreams([webEnglish, directGerman]);

    expect(result[0].name).toBe(DIRECT_STREAM_NAME);
    expect(result[1].name).toBe('Web Stream');
  });

  it('within the same language tier rankScore breaks the tie (higher score wins)', () => {
    const lowScore  = direct({ language: 'English', score: 40, speedScore: 40 });
    const highScore = direct({ language: 'English', score: 90, speedScore: 90 });

    const result = sortStreams([lowScore, highScore]);

    expect(rankScore(result[0])).toBeGreaterThan(rankScore(result[1]));
  });

  it('multiple foreign languages all rank below unknown-language streams', () => {
    const unknown = direct({});
    const french  = direct({ language: 'French' });
    const italian = direct({ language: 'Italian' });

    const result = sortStreams([french, italian, unknown]);

    expect(result[0].language).toBeUndefined();
    // Both french and italian must appear after unknown
    expect(result.slice(1).map(s => s.language)).toEqual(
      expect.arrayContaining(['French', 'Italian'])
    );
  });

  it('two unknown-language streams are ranked by rankScore between themselves', () => {
    const slower = direct({ speedScore: 20, score: 50 });
    const faster = direct({ speedScore: 80, score: 50 });

    const result = sortStreams([slower, faster]);

    // faster has higher speedScore so its rankScore is higher -> comes first
    expect(rankScore(result[0])).toBeGreaterThanOrEqual(rankScore(result[1]));
  });
});
