const { mapMatchToMetaPreview } = require('../src/catalog');

describe('Fixture vs 24/7 Channel Classification', () => {
  test('live match with date="0" and matchup teams is NOT branded as 24/7', () => {
    const match = {
      id: 'ak47_utah_mammoth_vs_tampa_bay_lightning',
      title: 'Utah Mammoth vs Tampa Bay Lightning',
      category: 'hockey',
      league: 'NHL Hockey',
      date: '0',
      status: 'LIVE',
      team1: { name: 'Utah Mammoth' },
      team2: { name: 'Tampa Bay Lightning' },
      sources: [{ source: 'ak47live', id: 'https://example.com/stream.m3u8' }]
    };

    const metaPreview = mapMatchToMetaPreview(match, {});
    expect(metaPreview.releaseInfo).toBe('LIVE');
    expect(metaPreview.name).toMatch(/^🔴 LIVE:/);
    expect(metaPreview.name).not.toContain('📺');
    expect(metaPreview.description).toContain('🔴 LIVE NOW');
    expect(metaPreview.description).not.toContain('24/7 Live Network');
  });

  test('Football match without explicit date is NOT branded as 24/7', () => {
    const match = {
      id: 'football_philadelphia_union_new_england_revolution_20750',
      title: 'Philadelphia Union vs New England Revolution',
      category: 'football',
      date: '0',
      status: 'live',
      team1: { name: 'Philadelphia Union' },
      team2: { name: 'New England Revolution' },
      sources: [{ source: 'ak47live', id: 'streamed:20750' }]
    };

    const metaPreview = mapMatchToMetaPreview(match, {});
    expect(metaPreview.releaseInfo).toBe('LIVE');
    expect(metaPreview.name).toMatch(/^🔴 LIVE:/);
    expect(metaPreview.description).toContain('🔴 LIVE NOW');
    expect(metaPreview.description).not.toContain('24/7 Live Network');
  });

  test('genuine 24/7 channel with networks category IS branded as 24/7', () => {
    const channel = {
      id: 'cdn_ch_xx_fox_cricket',
      title: 'Fox Cricket 501',
      category: 'networks',
      date: '0',
      status: 'live',
      sources: [{ source: 'cdnlive', id: 'fox_cricket' }]
    };

    const metaPreview = mapMatchToMetaPreview(channel, {});
    expect(metaPreview.releaseInfo).toBe('24/7');
    expect(metaPreview.name).toMatch(/^📺/);
    expect(metaPreview.description).toContain('24/7 Live Network');
  });

  test('genuine 24/7 channel with dlv_ch_ prefix IS branded as 24/7', () => {
    const channel = {
      id: 'dlv_ch_105',
      title: 'Sky Sports Premier League',
      category: 'networks',
      isChannel: true,
      date: '0',
      status: 'live',
      sources: [{ source: 'daddylive', id: '105' }]
    };

    const metaPreview = mapMatchToMetaPreview(channel, {});
    expect(metaPreview.releaseInfo).toBe('24/7');
    expect(metaPreview.name).toMatch(/^📺/);
    expect(metaPreview.description).toContain('24/7 Live Network');
  });
});
