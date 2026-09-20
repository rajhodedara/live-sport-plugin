'use strict';

// Unit tests for the language-tier sort baked into handleStream.
// We test the comparator logic directly by constructing minimal stream objects
// and running the same sort that streams.js applies, rather than driving the
// full handleStream path (which needs the whole match cache + network).

// ─── Replicate the exact sort used in streams.js ──────────────────────────────
// English first (tier 0), unknown language middle (tier 1), known-foreign last (tier 2).
// Within the same tier: rankScore = score*0.8 + speedScore*0.2.
const langTier = (s) => (s.language === 'English' ? 0 : (s.language ? 2 : 1));
const rankScore = (s) => ((s.score || 0) * 0.8) + ((s.speedScore ?? 50) * 0.2);

function sortStreams(streams) {
  return [...streams].sort((a, b) => {
    const aIsDirect = a.name === '⚡ Direct Stream' ? 1 : 0;
    const bIsDirect = b.name === '⚡ Direct Stream' ? 1 : 0;
    if (aIsDirect !== bIsDirect) return bIsDirect - aIsDirect;
    const lt = langTier(a) - langTier(b);
    if (lt) return lt;
    return rankScore(b) - rankScore(a);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const direct = (overrides = {}) => ({
  name: '⚡ Direct Stream',
  score: 50,
  speedScore: 50,
  ...overrides,
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
    const webEnglish   = { name: '🌐 Web Stream',   language: 'English', score: 99, speedScore: 99 };
    const directGerman = { name: '⚡ Direct Stream', language: 'German',  score: 1,  speedScore: 1  };

    const result = sortStreams([webEnglish, directGerman]);

    expect(result[0].name).toBe('⚡ Direct Stream');
    expect(result[1].name).toBe('🌐 Web Stream');
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

    // faster has higher speedScore so its rankScore is higher → comes first
    expect(rankScore(result[0])).toBeGreaterThanOrEqual(rankScore(result[1]));
  });
});
