const { selectSources, KNOWN_LIVE_SOURCES, KNOWN_FALLBACKS, SOURCE_PRIORITY, NICE_NAMES } = require('../src/streams');

describe('RoxieStreams streams.js Integration', () => {
  test('KNOWN_LIVE_SOURCES and KNOWN_FALLBACKS include roxiestreams', () => {
    expect(KNOWN_LIVE_SOURCES).toContain('roxiestreams');
    expect(KNOWN_FALLBACKS).toContain('roxiestreams');
  });

  test('SOURCE_PRIORITY and NICE_NAMES map roxiestreams', () => {
    expect(SOURCE_PRIORITY.roxiestreams).toBe(5);
    expect(NICE_NAMES.roxiestreams).toBe('RoxieStreams');
  });

  test('selectSources retains roxiestreams by default without custom config', () => {
    const candidateSources = [
      { source: 'streamsports99', id: 's99_1' },
      { source: 'roxiestreams', id: '/soccer-streams-1' }
    ];

    const selected = selectSources(candidateSources);
    expect(selected.some(s => s.source === 'roxiestreams')).toBe(true);
    // roxiestreams (P5) should rank before streamsports99 (P10)
    expect(selected[0].source).toBe('roxiestreams');
  });

  test('selectSources filters roxiestreams when liveSources restricts it', () => {
    const candidateSources = [
      { source: 'daddylive', id: '1' },
      { source: 'roxiestreams', id: '/soccer-streams-1' }
    ];

    const selected = selectSources(candidateSources, { liveSources: 'daddylive' });
    expect(selected.map(s => s.source)).toEqual(['daddylive']);
  });
});
