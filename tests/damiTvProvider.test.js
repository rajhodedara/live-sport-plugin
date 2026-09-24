'use strict';

// DamiTV provider regression suite.
//
// Each case pins a defect found in the 2026-09-23 integration audit:
//   - resolved URLs were emitted raw, so verifyStreams fetched them directly,
//     got a 403 from the CDN, and deleted every stream at mint time
//   - the 24/7 channels were never ingested (they live in /papi/matches/all,
//     not in the /papi/api/streams feed the provider read)
//   - fixture ids contain "/", which truncates the Stremio router path
//   - the feed's sources[].id is a server label ("s1"/"sd"), so the
//     MatchAggregator (id, source) dedup collapsed distinct servers into one
//   - a fixture's sd=1 sibling source hits the same extract endpoint and
//     minted a duplicate HD+SD pair
//   - liveness was inferred from a 12h window instead of the feed's own
//     status word, so upcoming fixtures were advertised as live
//
// The network seam is the provider's own proxyFetch / fetch wrappers, so no
// socket is opened and impit never loads. NODE_ENV=test also keeps the CF
// proxy pool off.

process.env.NODE_ENV = 'test';

jest.mock('../src/impitClient', () => ({
  safeFetch: jest.fn()
}));
const { safeFetch } = require('../src/impitClient');

const DamiTvProvider = require('../src/providers/DamiTvProvider');
const CircuitBreakerService = require('../src/services/CircuitBreakerService');

const FEED_TS = 1790000000;

/** A scheduled fixture: real kickoff, both teams present. */
function fixtureItem(over = {}) {
  return Object.assign({
    id: 'mlb/2026-09-23/wsh-det',
    name: 'Washington Nationals vs. Detroit Tigers',
    poster: 'https://example.test/poster.jpg',
    starts_at: FEED_TS + 3600,
    ends_at: FEED_TS + 14400,
    status: 'upcoming',
    league: 'MLB',
    teams: {
      home: { name: 'Washington Nationals', badge: 'https://example.test/h.png' },
      away: { name: 'Detroit Tigers', badge: 'https://example.test/a.png' }
    },
    viewers: 0,
    always_live: 0,
    sources: [{ source: 'hls', id: 's1', name: 'Server 1', embed: '/embed/?id=mlb%2F2026-09-23%2Fwsh-det' }],
    iframe: '/embed/?id=mlb%2F2026-09-23%2Fwsh-det'
  }, over);
}

/** An always-on channel: no away team, kickoff pinned to the feed clock. */
function channelItem(over = {}) {
  return Object.assign({
    id: 'nfl-network',
    name: 'NFL Network',
    poster: 'https://example.test/nfl.jpg',
    starts_at: FEED_TS,
    ends_at: FEED_TS + 10800,
    status: 'live',
    league: 'NFL',
    teams: { home: { name: 'NFL Network', badge: '' }, away: { name: '', badge: '' } },
    viewers: 4,
    always_live: 0,
    sources: [{ source: 'hls', id: 's1', name: 'Server 1', embed: '/embed/?id=nfl-network' }],
    iframe: '/embed/?id=nfl-network'
  }, over);
}

/** An item in the /papi/matches/all shape (title/date in ms, not name/starts_at). */
function allItem(over = {}) {
  return Object.assign({
    id: '247-south-park',
    league: '24/7 Streams',
    title: '24/7 South Park',
    category: '24/7-streams',
    date: FEED_TS * 1000,
    popular: false,
    poster: 'https://example.test/sp.jpg',
    teams: { home: { name: '24/7 South Park', badge: '' }, away: { name: '', badge: '' } },
    sources: [{ source: 'ppv', id: '247-south-park' }],
    status: 'live',
    viewers: 13,
    embedUrl: 'https://embedindia.st/embed/247-south-park',
    substreams: []
  }, over);
}

function feedPayload(items) {
  return { success: true, timestamp: FEED_TS, streams: [{ category: 'baseball', streams: items }] };
}

/**
 * Provider with both feeds stubbed. fetchData/fetchAllMatches are the objects
 * the constructor already wrapped in a circuit breaker; replacing them keeps
 * every code path under test while touching no network.
 */
function makeProvider(opts = {}) {
  const provider = new DamiTvProvider(Object.assign({
    circuitBreaker: new CircuitBreakerService(),
    embedStProvider: null,
    embedIndiaProvider: null,
    logger: { warn() {}, error() {}, info() {}, debug() {} }
  }, opts));

  provider.fetchData = { fire: async () => opts.feedPayload };
  provider.fetchAllMatches = { fire: async () => opts.allPayload };
  return provider;
}

describe('DamiTvProvider.getMatches — fixtures', () => {
  test('keeps the league prefix and the real kickoff for a scheduled fixture', async () => {
    const provider = makeProvider({ feedPayload: feedPayload([fixtureItem()]), allPayload: [] });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(m.title).toBe('MLB - Washington Nationals vs. Detroit Tigers');
    expect(m.category).toBe('baseball');
    expect(m.date).toBe(String((FEED_TS + 3600) * 1000));
    expect(m.status).toBe('upcoming');
  });

  test("trusts the feed's status word instead of a 12h clock window", async () => {
    // Kickoff two hours in the past, but the feed still calls it upcoming.
    // The old rule promoted anything within 12h of now to live.
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem({ status: 'upcoming', starts_at: FEED_TS - 7200 })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    expect(matches[0].status).toBe('upcoming');
    expect(matches[0].popular).toBe('0');
  });

  test('drops terminal statuses rather than advertising them', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([
        fixtureItem({ id: 'a/1', status: 'finished' }),
        fixtureItem({ id: 'b/1', status: 'upcoming' })
      ]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches.map((m) => m.id)).toEqual(['dami_b_1']);
  });

  test('marks a live fixture popular', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem({ status: 'live' })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches[0].status).toBe('live');
    expect(matches[0].popular).toBe('1');
  });
});

describe('DamiTvProvider.getMatches — rolling-window channels', () => {
  test('classifies a rolling-window channel as a 24/7 network', async () => {
    const provider = makeProvider({ feedPayload: feedPayload([channelItem()]), allPayload: [] });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    const m = matches[0];
    // No league prefix: the catalog matches channel logos by exact title.
    expect(m.title).toBe('NFL Network');
    expect(m.category).toBe('networks');
    expect(m.date).toBe('');
    expect(m.popular).toBe('1');
    expect(m.status).toBe('');
    expect(m.league).toBe('Live TV');
  });

  test('a fixture that merely starts soon is NOT a channel', async () => {
    // Same "no away team" shape, but the kickoff is nowhere near the clock.
    const provider = makeProvider({
      feedPayload: feedPayload([channelItem({
        id: 'f1/2026/azerbaijan/fp1',
        name: 'Azerbaijan Grand Prix - Practice 1',
        starts_at: FEED_TS + 73963,
        league: 'Motorsports'
      })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    // The point is the classification, not the sport: a distant kickoff must
    // keep it out of the 24/7 row and keep its league prefix.
    expect(matches[0].category).not.toBe('networks');
    expect(matches[0].title).toBe('Motorsports - Azerbaijan Grand Prix - Practice 1');
    expect(matches[0].date).toBe(String((FEED_TS + 73963) * 1000));
  });

  test('tolerates a small clock skew when detecting a channel', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([
        channelItem({ id: 'ch-a', starts_at: FEED_TS + 45 }),
        channelItem({ id: 'ch-b', starts_at: FEED_TS + 200 })
      ]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    // 45s is inside the ±90s tolerance, 200s is not.
    const byId = Object.fromEntries(matches.map((m) => [m.id, m]));
    expect(byId['dami_ch-a'].category).toBe('networks');
    expect(byId['dami_ch-b'].category).not.toBe('networks');
  });
});

describe('DamiTvProvider.getMatches — id sanitization', () => {
  test('collapses slashes so the Stremio router can match the id', async () => {
    const provider = makeProvider({ feedPayload: feedPayload([fixtureItem()]), allPayload: [] });
    const matches = await provider.getMatches();

    expect(matches[0].id).toBe('dami_mlb_2026-09-23_wsh-det');
    expect(matches[0].id).not.toContain('/');
  });

  test('the true feed id survives inside the source embed url', async () => {
    const provider = makeProvider({ feedPayload: feedPayload([fixtureItem()]), allPayload: [] });
    const matches = await provider.getMatches();

    const url = new URL(matches[0].sources[0].url);
    expect(url.searchParams.get('id')).toBe('mlb/2026-09-23/wsh-det');
  });

  test('skips a second entry that sanitizes to the same id', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([
        fixtureItem({ id: 'mlb/x' }),
        fixtureItem({ id: 'mlb_x', name: 'Different Event' })
      ]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
  });
});

describe('DamiTvProvider.getMatches — source identity', () => {
  test('two servers on one event keep distinct source ids', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem({
        sources: [
          { source: 'hls', id: 's1', name: 'Server 1', embed: '/embed/?id=evt-1' },
          { source: 'hls', id: 's2', name: 'Server 2', embed: '/embed/?id=evt-2' }
        ]
      })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    const ids = matches[0].sources.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test('drops an sd sibling that resolves to the same extract endpoint', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem({
        sources: [
          { source: 'hls', id: 's1', name: 'Server 1', embed: '/embed/?id=same-evt' },
          { source: 'sd', id: 'sd', name: 'Server 2 SD', embed: '/embed/?id=same-evt&sd=1' }
        ]
      })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    // One extract call returns both HD and SD already; the duplicate is noise.
    expect(matches[0].sources).toHaveLength(1);
    expect(matches[0].sources[0].url).toContain('same-evt');
  });

  test('keeps the sd source when it is the only one', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem({
        sources: [{ source: 'sd', id: 'sd', name: 'Server 2 SD', embed: '/embed/?id=only-sd&sd=1' }]
      })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches[0].sources).toHaveLength(1);
    expect(matches[0].sources[0].url).toContain('only-sd');
  });

  test('falls back to the canonical embed url when a source carries no embed', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem({ sources: [{ source: 'hls', id: 's1', name: 'Server 1' }] })]),
      allPayload: []
    });
    const matches = await provider.getMatches();

    expect(matches[0].sources).toHaveLength(1);
    const url = new URL(matches[0].sources[0].url);
    expect(url.searchParams.get('id')).toBe('mlb/2026-09-23/wsh-det');
  });
});

describe('DamiTvProvider.getMatches — 24/7 channel ingestion', () => {
  test('ingests /papi/matches/all 24/7-streams entries as networks', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([fixtureItem()]),
      allPayload: [allItem(), allItem({ id: '247-cows', title: '24/7 COWS' })]
    });
    const matches = await provider.getMatches();

    const networks = matches.filter((m) => m.category === 'networks');
    expect(networks.map((m) => m.title)).toEqual(['24/7 South Park', '24/7 COWS']);
    networks.forEach((m) => {
      expect(m.date).toBe('');
      expect(m.popular).toBe('1');
      expect(m.league).toBe('Live TV');
    });
  });

  test('ingests 247-* sport channels by id even outside the 24/7 category', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([]),
      allPayload: [allItem({ id: '247-fox-cricket', title: 'Fox Cricket', category: 'cricket' })]
    });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    expect(matches[0].category).toBe('networks');
    expect(matches[0].title).toBe('Fox Cricket');
  });

  test('ignores ordinary fixtures from /papi/matches/all', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([]),
      allPayload: [allItem({ id: 'nfl/2026-09-24/atl-gb', title: 'Atlanta Falcons at Green Bay Packers', category: 'american-football' })]
    });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(0);
  });

  test('does not double-ingest a channel the main feed already carried', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([channelItem({ id: 'nfl-network' })]),
      allPayload: [allItem({ id: 'nfl-network', title: 'NFL Network', category: 'american-football' })]
    });
    const matches = await provider.getMatches();

    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('NFL Network');
  });

  test('expands substreams into additional sources', async () => {
    const provider = makeProvider({
      feedPayload: feedPayload([]),
      allPayload: [allItem({
        id: '247-willow',
        title: 'Willow',
        category: 'cricket',
        substreams: [
          { id: '247-willow-2', name: 'Willow 2', iframe: 'https://embedindia.st/embed/247-willow-2' },
          { id: '247-willow-sports', name: 'Willow Sports', iframe: 'https://embedindia.st/embed/247-willow-sports' }
        ]
      })]
    });
    const matches = await provider.getMatches();

    const willow = matches.find((m) => m.title === 'Willow');
    expect(willow.sources).toHaveLength(3);
    expect(new Set(willow.sources.map((s) => s.id)).size).toBe(3);
  });

  test('a failing 24/7 feed is non-fatal', async () => {
    const provider = makeProvider({ feedPayload: feedPayload([fixtureItem()]), allPayload: [] });
    provider.fetchAllMatches = { fire: async () => { throw new Error('HTTP 503'); } };

    const matches = await provider.getMatches();
    expect(matches).toHaveLength(1);
  });

  test('a failing main feed still yields the 24/7 channels', async () => {
    const provider = makeProvider({ feedPayload: feedPayload([]), allPayload: [allItem()] });
    provider.fetchData = { fire: async () => { throw new Error('HTTP 503'); } };

    const matches = await provider.getMatches();
    expect(matches.map((m) => m.title)).toEqual(['24/7 South Park']);
  });
});

describe('DamiTvProvider.resolveStream — proxied direct streams', () => {
  const EXTRACT_OK = {
    success: true,
    source: 'ppv',
    hlsUrl: 'https://messi.damitv.st/live-hls/channel/nfl-network/playlist.m3u8?tk=AAA&e=1',
    sdUrl: 'https://messi.damitv.st/live-sd/streamed/admin/ppv-nfl-network/2/playlist.m3u8?tk=AAA&e=1',
    embedUrl: 'https://embedindia.st/embed/nfl-network'
  };

  function providerWithExtract(payload, opts = {}) {
    const provider = makeProvider(opts);
    provider.proxyFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    }));
    return provider;
  }

  test('wraps both upstream URLs in the manifest proxy', async () => {
    const provider = providerWithExtract(EXTRACT_OK);
    const streams = await provider.resolveStream(
      's', 'networks', 'NFL Network',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=nfl-network' }
    );

    expect(streams).toHaveLength(2);
    streams.forEach((s) => {
      expect(s.url).toContain('/api/manifest?url=');
      expect(s.behaviorHints.notWebReady).toBe(true);
    });
    expect(streams.map((s) => s.resolution)).toEqual(['HD', 'SD']);
  });

  test('carries the damitv referer and origin into the proxy', async () => {
    const provider = providerWithExtract(EXTRACT_OK);
    const streams = await provider.resolveStream(
      's', 'networks', 'NFL Network',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=nfl-network' }
    );

    const q = new URL(streams[0].url).searchParams;
    expect(q.get('url')).toBe(EXTRACT_OK.hlsUrl);
    expect(q.get('referer')).toBe('https://damitv.st/');
    expect(q.get('origin')).toBe('https://damitv.st');
  });

  test('titles carry no parenthesised suffix that would read as a channel name', async () => {
    const provider = providerWithExtract(EXTRACT_OK);
    const streams = await provider.resolveStream(
      's', 'networks', 'NFL Network',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=nfl-network' }
    );

    streams.forEach((s) => {
      expect(s.title).toBe('NFL Network');
      expect(s.title).not.toMatch(/\(/);
    });
  });

  test('url-encodes the match id in the extract path', async () => {
    const provider = providerWithExtract(EXTRACT_OK);
    await provider.resolveStream(
      's', 'baseball', 'MLB - A vs B',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=mlb%2F2026-09-23%2Fwsh-det' }
    );

    const calledUrl = provider.proxyFetch.mock.calls[0][0];
    expect(calledUrl).toBe('https://damitv.st/papi/extract-url/mlb%2F2026-09-23%2Fwsh-det');
    expect(calledUrl).not.toMatch(/extract-url\/mlb\//);
  });

  test('emits only the variants the API actually returned', async () => {
    const provider = providerWithExtract({ success: true, hlsUrl: 'https://x.test/a.m3u8' });
    const streams = await provider.resolveStream(
      's', 'golf', 'Sky Sports Golf',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=sky-sports-golf' }
    );

    expect(streams).toHaveLength(1);
    expect(streams[0].resolution).toBe('HD');
    expect(streams[0].url).toContain(encodeURIComponent('https://x.test/a.m3u8'));
  });
});

describe('DamiTvProvider.resolveStream — fallbacks', () => {
  test('falls back to the web player when every direct path is dead', async () => {
    const provider = makeProvider({ embedStProvider: null, embedIndiaProvider: null });
    provider.proxyFetch = jest.fn(async () => { throw new Error('timeout'); });

    const streams = await provider.resolveStream(
      's', 'football', 'X vs Y',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=evt-x' }
    );

    expect(streams).toHaveLength(1);
    expect(streams[0].externalUrl).toContain('/watch?url=');
    expect(streams[0].externalUrl).toContain(encodeURIComponent('https://damitv.st/embed/?id=evt-x'));
  });

  test('relabels a handed-off stream so it reports as DamiTV', async () => {
    const embedStProvider = {
      resolveStream: jest.fn(async () => [
        { name: 'EmbedSt', title: 'EmbedSt (Live)' },
        { name: 'EmbedSt', title: 'EmbedIndia Web Player' }
      ])
    };
    const provider = makeProvider({ embedStProvider, embedIndiaProvider: null });
    provider.proxyFetch = jest.fn(async () => { throw new Error('nope'); });

    const streams = await provider.resolveStream(
      's', 'football', 'X vs Y',
      { source: 'damitv', url: 'https://damitv.st/embed/?id=evt-x' }
    );

    streams.forEach((s) => {
      expect(s.name).toBe('DamiTV');
      expect(s.title).not.toMatch(/EmbedSt|EmbedIndia/);
    });
  });

  test('returns nothing for an embed url with no id param', async () => {
    const provider = makeProvider({});
    provider.proxyFetch = jest.fn();

    const streams = await provider.resolveStream('s', 'football', 'X', { source: 'damitv', url: 'https://damitv.st/embed/' });
    expect(streams).toHaveLength(0);
    expect(provider.proxyFetch).not.toHaveBeenCalled();
  });
});
