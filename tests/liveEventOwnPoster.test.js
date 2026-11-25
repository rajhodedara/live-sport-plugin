'use strict';

const { mapMatchToMetaPreview } = require('../src/catalog');

describe('Live & upcoming events always use own /img/match poster', () => {
  test('live cricket match with FanCode provider poster uses /img/match instead of /img?url=', () => {
    const match = {
      id: 'sktech_ev_fancode_4249676',
      title: 'South Australia vs Victoria',
      category: 'cricket',
      league: 'Sheffield Shield',
      date: String(Date.now() - 30 * 60 * 1000),
      status: 'live',
      poster: 'https://www.fancode.com/skillup-uploads/cms-media/4249676_53087_SAU_VCT_FC-WEB.jpg',
      thumbnail_url: 'https://www.fancode.com/skillup-uploads/cms-media/4249676_53087_SAU_VCT_FC-WEB.jpg',
      background: 'https://www.fancode.com/skillup-uploads/cms-media/4249676_53087_SAU_VCT_FC-WEB.jpg',
      team1: { name: 'South Australia' },
      team2: { name: 'Victoria' },
      sources: [{ source: 'sktech', id: 'fancode_4249676' }]
    };

    const meta = mapMatchToMetaPreview(match, {}, 'tv');
    expect(meta.poster).toContain('/img/match?');
    expect(meta.poster).not.toContain('fancode.com');
    expect(meta.background).toContain('/img/match?');
    expect(meta.background).not.toContain('fancode.com');
  });

  test('upcoming event with provider poster/logo uses /img/match', () => {
    const match = {
      id: 'dlv_event_upcoming_1',
      title: 'Bangladesh vs South Africa',
      category: 'cricket',
      date: String(Date.now() + 2 * 3600 * 1000),
      status: 'upcoming',
      poster: 'https://example.com/provider-poster.jpg',
      logo: 'https://example.com/provider-logo.png',
      sources: [{ source: 'daddylive', id: '1' }]
    };

    const meta = mapMatchToMetaPreview(match, {}, 'tv');
    expect(meta.poster).toContain('/img/match?');
    expect(meta.poster).not.toContain('provider-poster.jpg');
    expect(meta.poster).not.toContain('provider-logo.png');
  });

  test('24/7 channels still use channel/provider artwork via /img?url=', () => {
    const channel = {
      id: 'cdn_ch_xx_sky-sports-cricket',
      title: 'Sky Sports Cricket',
      category: 'networks',
      date: '0',
      status: 'live',
      sources: [{ source: 'cdnlive', id: 'sky-sports-cricket' }]
    };

    const meta = mapMatchToMetaPreview(channel, {}, 'tv');
    expect(meta.poster).toContain('/img?url=');
    expect(meta.poster).toContain('embed=1');
  });

  test('replays still preserve provider poster/thumbnail via /img?url=', () => {
    const replay = {
      id: 'rz_test_replay_1',
      title: 'India vs Australia - Full Match Replay',
      category: 'cricket',
      date: '2026-09-18',
      status: 'finished',
      thumbnail_url: 'https://fullraces.com/_pu/15/12345678.png',
      sources: [{ source: 'replayzone', id: 'https://ok.ru/videoembed/12345' }]
    };

    const meta = mapMatchToMetaPreview(replay, {}, 'tv');
    expect(meta.poster).toContain('/img?url=');
    expect(meta.poster).toContain('fullraces.com');
  });
});
