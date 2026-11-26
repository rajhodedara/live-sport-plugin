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

describe('Kafka event-first stream ordering', () => {
  const prevFlag = process.env.KAFKA_EVENT_FIRST_ENABLED;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.KAFKA_EVENT_FIRST_ENABLED;
    else process.env.KAFKA_EVENT_FIRST_ENABLED = prevFlag;
  });

  const { hasExplicitLanguage } = require('../src/services/LanguagePriorityService');

  it('orders verified Kafka event, broadcaster, team, then other sources by default', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    const streams = [
      direct({ _source: 'daddylive', language: 'English', score: 100 }),
      direct({ _source: 'kafka', _kafkaMatchMode: 'team', language: 'English', score: 90 }),
      direct({ _source: 'kafka', language: 'English', score: 50 }), // pre-change cached row without mode -> broadcaster tier
      direct({ _source: 'kafka', _kafkaMatchMode: 'event', language: 'Swedish', score: 10 })
    ];

    const sorted = [...streams].sort((a, b) => compareStreams(a, b, [], hasExplicitLanguage({})));
    expect(sorted.map((s) => `${s._source}:${s._kafkaMatchMode || 'legacy'}`)).toEqual([
      'kafka:event',
      'kafka:legacy',
      'kafka:team',
      'daddylive:legacy'
    ]);
  });

  it('preserves explicit language preferences and ranks Kafka modes inside a language', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    const config = { languages: 'Spanish' };
    const priorities = parseLanguagePriority(config);
    const streams = [
      direct({ _source: 'kafka', _kafkaMatchMode: 'event', language: 'Swedish', score: 95 }),
      direct({ _source: 'daddylive', language: 'Spanish', score: 90 }),
      direct({ _source: 'kafka', _kafkaMatchMode: 'team', language: 'Spanish', score: 40 }),
      direct({ _source: 'kafka', _kafkaMatchMode: 'label', language: 'Spanish', score: 30 }),
      direct({ _source: 'kafka', _kafkaMatchMode: 'event', language: 'Spanish', score: 20 })
    ];

    const sorted = [...streams].sort((a, b) => compareStreams(a, b, priorities, hasExplicitLanguage(config)));
    expect(sorted.map((s) => `${s.language}:${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual([
      'Spanish:kafka:event',
      'Spanish:kafka:label',
      'Spanish:kafka:team',
      'Spanish:daddylive:none',
      'Swedish:kafka:event'
    ]);
  });

  it('ignores unknown language typos for event-first mode while honoring explicit English', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    expect(hasExplicitLanguage({ languages: 'Klingon' })).toBe(false);
    expect(hasExplicitLanguage({ languages: 'English' })).toBe(true);
    expect(hasExplicitLanguage({ languages: '   ' })).toBe(false);
  });

  it('restores legacy order when KAFKA_EVENT_FIRST_ENABLED=false', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'false';
    const streams = [
      direct({ _source: 'kafka', _kafkaMatchMode: 'event', language: 'Swedish', score: 90 }),
      direct({ _source: 'daddylive', language: 'English', score: 80 }),
      direct({ _source: 'kafka', _kafkaMatchMode: 'team', language: 'English', score: 70 })
    ];

    const sorted = [...streams].sort((a, b) => compareStreams(a, b, [], false));
    expect(sorted.map((s) => `${s.language}:${s._source}:${s._kafkaMatchMode || 'none'}`)).toEqual([
      'English:kafka:team',
      'English:daddylive:none',
      'Swedish:kafka:event'
    ]);
  });
});

describe('Mixed Kafka fixture quality ranking', () => {
  const prevFlag = process.env.KAFKA_EVENT_FIRST_ENABLED;
  afterEach(() => {
    if (prevFlag === undefined) delete process.env.KAFKA_EVENT_FIRST_ENABLED;
    else process.env.KAFKA_EVENT_FIRST_ENABLED = prevFlag;
  });

  const { hasExplicitLanguage } = require('../src/services/LanguagePriorityService');

  it('ranks a same-language 1080p broadcaster ahead of a 720p event in mixed mode while preserving legacy event-first default', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    const channel1080 = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'label',
      language: 'English',
      _kafkaVerifiedHeight: 1080,
      score: 60
    });
    const event720 = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'event',
      language: 'English',
      _kafkaVerifiedHeight: 720,
      score: 95
    });

    expect(compareStreams(channel1080, event720, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
    expect(compareStreams(event720, channel1080, [], false)).toBeLessThan(0);
  });

  it('prefers event over broadcaster at the same verified quality and keeps team/untagged below both', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    const event1080 = direct({ _source: 'kafka', _kafkaMatchMode: 'event', language: 'English', _kafkaVerifiedHeight: 1080, score: 50 });
    const channel1080 = direct({ _source: 'kafka', _kafkaMatchMode: 'label', language: 'English', _kafkaVerifiedHeight: 1080, score: 90 });
    const team4k = direct({ _source: 'kafka', _kafkaMatchMode: 'team', language: 'English', _kafkaVerifiedHeight: 2160, score: 99 });
    const untagged4k = direct({ _source: 'kafka', language: 'English', _kafkaVerifiedHeight: 2160, score: 99 });

    expect(compareStreams(event1080, channel1080, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
    expect(compareStreams(event1080, team4k, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
    expect(compareStreams(channel1080, team4k, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
    expect(compareStreams(channel1080, untagged4k, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
  });

  it('ignores claimed 8K title/resolution tags without measured evidence and uses bitrate fallback + secondary bps', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    const claimed8kEvent = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'event',
      title: 'Live | Team A vs Team B | 8K EXCLUSIVE',
      resolution: '2160p',
      quality: '8K',
      language: 'English',
      _kafkaMeasuredBitrateBps: 2500000 // 720p estimate
    });
    const channel1080 = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'label',
      title: 'US| NBA TV HD',
      resolution: 'HD',
      language: 'English',
      _kafkaVerifiedHeight: 1080
    });
    const unverified8kEvent = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'event',
      title: 'Live | Team A vs Team B | 8K EXCLUSIVE',
      resolution: '2160p',
      language: 'English'
    });
    const channelHigherBps = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'label',
      language: 'English',
      _kafkaMeasuredBitrateBps: 6000000 // 1080p tier, higher bps
    });
    const eventLowerBps = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'event',
      language: 'English',
      _kafkaMeasuredBitrateBps: 4200000 // 1080p tier, lower bps
    });

    expect(compareStreams(channel1080, claimed8kEvent, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
    expect(compareStreams(channel1080, unverified8kEvent, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
    expect(compareStreams(channelHigherBps, eventLowerBps, [], false, { mixedKafkaFixture: true })).toBeLessThan(0);
  });

  it('preserves explicit language preference over a higher quality channel in a less preferred language', () => {
    process.env.KAFKA_EVENT_FIRST_ENABLED = 'true';
    const config = { languages: 'Spanish' };
    const priorities = parseLanguagePriority(config);
    const spanish720 = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'label',
      language: 'Spanish',
      _kafkaVerifiedHeight: 720
    });
    const german1080 = direct({
      _source: 'kafka',
      _kafkaMatchMode: 'label',
      language: 'German',
      _kafkaVerifiedHeight: 1080
    });

    expect(compareStreams(spanish720, german1080, priorities, hasExplicitLanguage(config), { mixedKafkaFixture: true })).toBeLessThan(0);
  });

  it('keeps equal-height Kafka feeds in the same order when a bitrate is missing', () => {
    const feed = (matchMode, bitrate, score) => direct({
      _source: 'kafka', _kafkaMatchMode: matchMode, language: 'English',
      _kafkaVerifiedHeight: 1080, _kafkaMeasuredBitrateBps: bitrate, score
    });
    const fastChannel = feed('label', 6000000, 20);
    const event = feed('event', 4200000, 70);
    const unmeasuredChannel = feed('label', undefined, 99);
    const compare = (a, b) => compareStreams(a, b, [], false, { mixedKafkaFixture: true });

    for (const input of [
      [fastChannel, event, unmeasuredChannel],
      [unmeasuredChannel, fastChannel, event],
      [event, unmeasuredChannel, fastChannel]
    ]) {
      expect(input.sort(compare)).toEqual([fastChannel, event, unmeasuredChannel]);
    }
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
