'use strict';

const fs = require('fs');

/**
 * Regression suite for two production-reported defects:
 *
 * 1. Live-section contamination -- finished and upcoming events appeared in the
 *    Live catalog because provider status flags could override the kickoff
 *    clock (StreamedPk mints a "live" flag from a stream probe; DaddyLive
 *    leaves the status empty; StreamSports99/CdnLive hardcode "upcoming").
 *    The kickoff clock is now authoritative: a future kickoff is never live,
 *    and a past kickoff beyond the sport window is never live.
 *
 * 2. Empty team logos -- composed card SVGs embedded crest URLs built from the
 *    process-level BASE_URL, which on the production deployment is the server's
 *    internal LAN address. The client could load the card but never the crests.
 *    Embedded references now derive from the client's own request host
 *    (src/services/EmbedBase.js), and loopback bases are refused so the card
 *    degrades to its crest plate / monogram instead of an unfetchable image.
 */

const HOUR = 3600 * 1000;
const now = Date.now();

const { isMatchLive } = require('../src/catalog');
const { resolveEmbedBase, isUnreachableHost } = require('../src/services/EmbedBase');
const TeamLogoService = require('../src/services/TeamLogoService');

describe('isMatchLive: the kickoff clock is authoritative', () => {
  test('a stale "live" flag with a FUTURE kickoff is not live', () => {
    // StreamedPk flags any event with an active stream probe as live, so an
    // upcoming fixture used to appear in the Live section.
    const m = {
      id: 'spk_future-live',
      title: 'Anaheim Ducks vs Los Angeles Kings',
      category: 'hockey',
      status: 'live',
      date: String(now + 6 * HOUR),
      sources: [{ source: 'streamedpk', id: 'x' }]
    };
    expect(isMatchLive(m)).toBe(false);
  });

  test('a stale "live" flag with a future kickoff stays not live near kickoff', () => {
    const m = {
      id: 'spk_future-live-2', title: 'A vs B', category: 'football',
      status: 'live', date: String(now + 15 * 60 * 1000), sources: []
    };
    expect(isMatchLive(m)).toBe(false);
  });

  test('a genuinely in-progress match is still live (no false negatives)', () => {
    const m = {
      id: 'spk_inplay', title: 'A vs B', category: 'football',
      status: 'live', date: String(now - 35 * 60 * 1000), sources: []
    };
    expect(isMatchLive(m)).toBe(true);
  });

  test('an in-progress match still flagged "upcoming" is live (existing regression)', () => {
    // StreamSports99 reports "upcoming" even for games in progress; the clock
    // must keep such matches live and NOT drop them into replays.
    const m = {
      id: 'ss99_inplay', title: 'A vs B', category: 'baseball',
      status: 'upcoming', date: String(now - 56 * 60 * 1000), sources: []
    };
    expect(isMatchLive(m)).toBe(true);
  });

  test('an empty status with a kickoff long past is not live (DaddyLive)', () => {
    // DaddyLive sets status = "" once kickoff has passed; the 12h default
    // window used to keep finished games in the Live section for half a day.
    const m = {
      id: 'dlv_ended', title: 'Japan vs India', category: 'football',
      status: '', date: String(now - 6 * HOUR), sources: []
    };
    expect(isMatchLive(m)).toBe(false);
  });

  test('an explicit finished status is never live', () => {
    const m = {
      id: 'f', title: 'A vs B', category: 'football',
      status: 'finished', date: String(now - 30 * 60 * 1000), sources: []
    };
    expect(isMatchLive(m)).toBe(false);
  });

  test('"upcoming" with no usable kickoff is not live', () => {
    const m = { id: 'u', title: 'A vs B', category: 'tennis', status: 'upcoming', sources: [] };
    expect(isMatchLive(m)).toBe(false);
  });

  test('a channel-like row with no date and no status stays available (24/7 shape)', () => {
    const m = { id: 'ch', title: 'Some Channel', category: 'other', status: '', sources: [] };
    expect(isMatchLive(m)).toBe(true);
  });

  test('24/7 networks are always live', () => {
    expect(isMatchLive({ id: 'n', title: 'Willow', category: 'networks', sources: [] })).toBe(true);
  });

  test('the live window is still sport-aware', () => {
    const within = { id: 'b', title: 'A vs B', category: 'baseball', status: '', date: String(now - 3 * HOUR), sources: [] };
    const past = { id: 'f', title: 'A vs B', category: 'football', status: '', date: String(now - 3 * HOUR), sources: [] };
    expect(isMatchLive(within)).toBe(true);   // baseball window is 3.5h
    expect(isMatchLive(past)).toBe(false);    // football window is 2.5h
  });
});

describe('resolveEmbedBase: embedded crest URLs follow the client host', () => {
  const req = (headers) => ({ headers, get: (k) => headers[k] });

  test('uses the public request host (production defect: BASE_URL LAN IP)', () => {
    const base = resolveEmbedBase(req({ host: 'nuviosports.xyz', 'x-forwarded-proto': 'https' }));
    expect(base).toBe('https://nuviosports.xyz');
  });

  test('honours X-Forwarded-Host behind a proxy', () => {
    const base = resolveEmbedBase(req({ host: 'internal.local', 'x-forwarded-host': 'nuviosports.xyz', 'x-forwarded-proto': 'https' }));
    expect(base).toBe('https://nuviosports.xyz');
  });

  test('keeps a non-default port', () => {
    const base = resolveEmbedBase(req({ host: 'myserver.example:7443', 'x-forwarded-proto': 'https' }));
    expect(base).toBe('https://myserver.example:7443');
  });

  test('refuses a loopback base so badges are omitted, never broken', () => {
    // A localhost request makes getRequestBaseUrl fall back to the process
    // BASE_URL, which is a private LAN IP on a proxied deployment. Embedding it
    // was the production defect, so it must be refused rather than emitted.
    expect(resolveEmbedBase(req({ host: 'localhost:7000' }))).toBeNull();
    expect(resolveEmbedBase(req({ host: '127.0.0.1:7000' }))).toBeNull();
    expect(resolveEmbedBase(req({ host: '192.168.0.123:7000' }))).toBeNull();
  });

  test('refuses an empty request', () => {
    expect(resolveEmbedBase(undefined)).toBeNull();
    expect(resolveEmbedBase(req({}))).toBeNull();
  });

  test('isUnreachableHost covers loopback spellings', () => {
    expect(isUnreachableHost('localhost')).toBe(true);
    expect(isUnreachableHost('sub.localhost')).toBe(true);
    expect(isUnreachableHost('127.0.0.1')).toBe(true);
    expect(isUnreachableHost('0.0.0.0')).toBe(true);
    expect(isUnreachableHost('::1')).toBe(true);
    expect(isUnreachableHost('nuviosports.xyz')).toBe(false);
    expect(isUnreachableHost('')).toBe(true);
    // Private ranges are refused too: a remote player cannot resolve them, and
    // getRequestBaseUrl yields the LAN IP BASE_URL for a localhost request.
    expect(isUnreachableHost('192.168.1.50')).toBe(true);
    expect(isUnreachableHost('10.0.0.5')).toBe(true);
    expect(isUnreachableHost('172.16.0.9')).toBe(true);
    expect(isUnreachableHost('172.31.255.1')).toBe(true);
    expect(isUnreachableHost('172.32.0.1')).toBe(false);
  });
});

describe('24/7 channel logos resolve to live assets', () => {
  const { getChannelLogo } = require('../src/services/ChannelLogoService');

  // Every path here returned HTTP 404 from the jsDelivr CDN, so
  // getChannelLogo() handed the card a dead URL, /img/badge 404'd through the
  // proxy, and the channel rendered with no logo on a gradient background.
  const DEAD_CHANNEL_PATHS = [
    'countries/international/motogp.png',
    'countries/international/wrc-plus.png',
    'countries/germany/magenta-sport-de.png',
    'countries/switzerland/blue-sport-ch.png',
    'countries/australia/fox-footy-504-au.png',
    'countries/international/dazn-hz.png',
    'countries/united-states/e-entertainment-television-us.png',
    'countries/united-states/trutv-us.png',
    'countries/italy/italia-1.png'
  ];

  test('no dead channel-logo path remains in the service', () => {
    const source = fs.readFileSync(require.resolve('../src/services/ChannelLogoService'), 'utf8');
    const stale = DEAD_CHANNEL_PATHS.filter((p) => source.includes(p));
    expect(stale).toEqual([]);
  });

  test('the reported channel titles now resolve to a live CDN asset', () => {
    // Titles taken from the production 24/7 catalog that previously had no logo.
    for (const title of ['Canal+ MotoGP France', 'Sky Sport MotoGP Italy', 'Rally TV', 'DAZN Ligue 1 France']) {
      const url = getChannelLogo(title);
      expect(url).toBeTruthy();
      expect(url.startsWith('https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/')).toBe(true);
      expect(url).not.toContain('motogp.png');
      expect(url).not.toContain('wrc-plus.png');
      expect(url).not.toContain('dazn-hz.png');
    }
  });

  test('German hockey broadcaster resolves to a live Austrian feed', () => {
    expect(getChannelLogo('Magenta Sport')).toContain('magenta-sport-1-at.png');
  });

  test('previously-dead brand aliases now map to a live asset', () => {
    // The curated map may resolve these to a different regional feed, so assert
    // the resolved URL is a real asset path rather than one exact file name.
    const expectations = [
      ['E! Entertainment', /e-entertainment/],
      ['truTV', /tru-?tv/],
      ['Italia 1', /italia1|italia-1/]
    ];
    for (const [title, re] of expectations) {
      const url = getChannelLogo(title);
      expect(url).toBeTruthy();
      expect(url).toMatch(re);
      expect(url).not.toBe('countries/united-states/e-entertainment-television-us.png');
      expect(url).not.toBe('countries/united-states/trutv-us.png');
      expect(url).not.toBe('countries/italy/italia-1.png');
    }
  });

  test('channels with no verified asset return null rather than a 404 URL', () => {
    // Returning null lets the card simply omit the logo instead of emitting a
    // guaranteed-404 reference (and avoids shipping adult artwork).
    const source = fs.readFileSync(require.resolve('../src/services/ChannelLogoService'), 'utf8');
    expect(source).not.toContain('playboy-tv.png');
    expect(source).not.toContain('rik-1-cy.png');
  });
});

describe('card background: one light source, no colour soup', () => {
  const { generateMatchCardSvg } = require('../src/services/MinimalistPosterService');

  // The previous background stacked warm-orange glow + teal glow + a diagonal
  // white streak + a per-sport tint + a vignette. Five overlapping washes
  // averaged the middle into a desaturated grey-brown haze and the teal fought
  // the sport accent. These pin the replacement contract.
  const layers = (svg) => (svg.match(/fill="url\(#[a-zA-Z]+\)"/g) || []);

  test('the competing coloured washes are gone', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live' });
    expect(svg).not.toContain('warmGlow');
    expect(svg).not.toContain('coolGlow');
    expect(svg).not.toContain('id="streak"');
    expect(svg).not.toContain('id="vignette"');
    // Teal must never appear as a competing accent.
    expect(svg).not.toContain('#17c9b8');
  });

  test('the base is a deep neutral, not a warm black', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live' });
    expect(svg).toContain('id="cardBg"');
    // The old warm values.
    expect(svg).not.toContain('#170e08');
    expect(svg).not.toContain('#0a0605');
    expect(svg).toContain('#141821');
  });

  test('a single arena light carries the sport accent', () => {
    const football = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live' });
    const hockey = generateMatchCardSvg({ category: 'hockey', team1: 'A', team2: 'B', status: 'live' });
    expect(football).toContain('id="arenaLight"');
    // Each sport still tints its own card (the identity the endpoint test checks).
    const accentOf = (svg) => (svg.match(/id="sportTint"[^>]*>.*?stop-color="(#[0-9a-f]{6})"/) || [])[1];
    expect(accentOf(football)).toBe('#10b981');
    expect(accentOf(hockey)).toBe('#06b6d4');
  });

  test('there is a bottom weight so the hero is grounded', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live' });
    expect(svg).toContain('id="floor"');
  });

  test('background texture is faint, not a white haze', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live' });
    // Terrace lines must stay well below any visible wash.
    const m = svg.match(/stroke-opacity="([0-9.]+)"/);
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeLessThanOrEqual(0.05);
  });

  test('secondary text clears a readable contrast floor', () => {
    const svg = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', status: 'live', time: '8:30 PM' });
    // No text fill may sit below ~0.55 alpha on the dark base.
    const fills = [...svg.matchAll(/<text[^>]*fill="rgba\(255,255,255,([0-9.]+)\)"/g)].map((m) => Number(m[1]));
    expect(fills.length).toBeGreaterThan(0);
    expect(Math.min(...fills)).toBeGreaterThanOrEqual(0.55);
  });
});

describe('generated cards are self-contained (logos actually render)', () => {
  const { generateMatchCardSvg } = require('../src/services/MinimalistPosterService');
  // 1x1 transparent PNG stand-in for an inlined badge.
  const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  test('the card endpoint inlines badge bytes instead of referencing a URL', () => {
    // An SVG used as a poster (<img>/poster slot) is rendered in a restricted
    // mode that does NOT fetch external subresources, so a nested
    // "/img/badge?url=..." href rendered as a logo-less card. This pins the
    // endpoint to inline data URIs.
    const source = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    expect(source).toContain('function entryToDataUri');
    expect(source).toContain('entryToDataUri(entry)');
    // The old nested-reference template must be gone.
    expect(source).not.toMatch(/\/img\/badge\?url=\$\{/);
  });

  test('a card built from data URIs has no external references', () => {
    const svg = generateMatchCardSvg({
      category: 'networks', title: 'CNN', channel: 'CNN', status: 'live',
      channelMark: DATA, channelBadge: DATA
    });
    const external = svg.match(/<image[^>]*href="(?!data:)/g) || [];
    expect(external).toEqual([]);
    expect(svg).toContain('data:image/png;base64,');
  });

  test('inlined cards stay within a sane poster payload', () => {
    // Two full-size logos plus chrome must not balloon past the budget.
    const svg = generateMatchCardSvg({ category: 'football', team1: 'A', team2: 'B', badge1: DATA, badge2: DATA, status: 'live' });
    expect(Buffer.byteLength(svg, 'utf8')).toBeLessThan(200 * 1024);
  });
});

describe('generated cards do not pin stale artwork for 24h', () => {
  test('match and embed SVGs use a short client TTL', () => {
    // These cards encode live state (status/score/kickoff) and embed badge URLs,
    // so a 24h cache kept serving pre-fix broken renders long after a deploy.
    const source = fs.readFileSync(require.resolve('../src/index'), 'utf8');
    const matchCards = source.match(/res\.setHeader\('Cache-Control', 'public, max-age=120, s-maxage=300, stale-while-revalidate=600'\);/g) || [];
    expect(matchCards.length).toBeGreaterThanOrEqual(2);
    // The generated-card handlers must no longer pin a 24h TTL.
    const indexHandlers = source.slice(source.indexOf("app.get(['/img/match'"), source.indexOf("app.get(['/img/badge'"));
    expect(indexHandlers).not.toContain('max-age=86400');
  });
});

describe('learned crests survive a deploy', () => {
  test('the runtime crest cache is not written inside the tracked tree', () => {
    // The deploy runs `git reset --hard HEAD`, so persisting learned crests into
    // a tracked path (src/data/team_logos_cache.json) meant every deploy wiped
    // every crest resolved since the last commit, and the site re-learned them
    // from scratch. The service must now write outside the tracked tree while
    // still reading the committed seed.
    const source = fs.readFileSync(require.resolve('../src/services/TeamLogoService'), 'utf8');
    expect(source).toContain('team_logos_seed.json');
    expect(source).toContain('function resolveCacheFile');
    // The runtime path must not be the tracked data directory.
    expect(source).not.toMatch(/const CACHE_FILE = path\.join\(__dirname/);
    expect(source).toContain("path.join(process.cwd(), 'data', 'team_logos_cache.json')");
  });

  test('the committed seed loads and serves known crests', () => {
    const TeamLogoService = require('../src/services/TeamLogoService');
    const svc = new TeamLogoService();
    expect(svc.cache.size).toBeGreaterThan(300);
    expect(svc.getCachedLogo('Arsenal')).toContain('uyhbfe1612467038.png');
  });

  test('the seed file is valid JSON with the curated entries', () => {
    const seed = require('../src/data/team_logos_seed.json');
    expect(Object.keys(seed).length).toBeGreaterThan(300);
    expect(seed.arsenal).toMatch(/^https:\/\//);
  });
});

describe('team names are recovered from the title when providers omit them', () => {
  const { mapMatchToMetaPreview } = require('../src/catalog');
  const base = { id: 'x', category: 'tennis', status: 'upcoming', sources: [{ source: 'streamedpk', id: '1' }] };
  const teamsOf = (title) => {
    const meta = mapMatchToMetaPreview({ ...base, title, date: String(Date.now() + 3600e3) }, {}, 'tv');
    const u = new URL(meta.poster);
    return [u.searchParams.get('t1'), u.searchParams.get('t2')];
  };

  test('a tennis head-to-head title yields both competitors', () => {
    // These arrived from the provider with no team1/team2, so the card had no
    // fixture shape and degraded to a bare text tile.
    expect(teamsOf('WTA - Singles: Barbora Krejcikova vs Anna-Lena Friedsam'))
      .toEqual(['Barbora Krejcikova', 'Anna-Lena Friedsam']);
    expect(teamsOf('HC Taifun U20 vs Krylya Sovetov Moscow U20'))
      .toEqual(['HC Taifun U20', 'Krylya Sovetov Moscow U20']);
    expect(teamsOf('Tuskegee Golden Tigers vs Benedict Tigers'))
      .toEqual(['Tuskegee Golden Tigers', 'Benedict Tigers']);
  });

  test('the derived competitors reach cast and the crest lookup', () => {
    const meta = mapMatchToMetaPreview({
      ...base, title: 'WTA - Singles: Alina Charaeva vs Sofia Kenin', date: String(Date.now() + 3600e3)
    }, {}, 'tv');
    expect(meta.cast).toEqual(['Alina Charaeva', 'Sofia Kenin']);
  });

  test('dash-separated event titles are NOT split into fake competitors', () => {
    // Motorsport and show titles are "X - Y" shaped but are not head-to-heads.
    for (const t of ['Formula 1 2026 - Azerbaijan GP', 'Nascar Cup Series 2026 - Hollywood Casino 400', '2026 NASCAR Cup Series Playoff at Kansas']) {
      expect(teamsOf(t)).toEqual([null, null]);
    }
  });

  test('a plain channel name yields no competitors', () => {
    expect(teamsOf('CNN')).toEqual([null, null]);
  });

  test('an explicit provider team pair still wins over the title', () => {
    const meta = mapMatchToMetaPreview({
      ...base, category: 'football', title: 'Some Promo String vs Other',
      team1: { name: 'Arsenal' }, team2: { name: 'Chelsea' }, date: String(Date.now() + 3600e3)
    }, {}, 'tv');
    const u = new URL(meta.poster);
    expect(u.searchParams.get('t1')).toBe('Arsenal');
    expect(u.searchParams.get('t2')).toBe('Chelsea');
  });
});

describe('logo map integrity and fuzzy channel matching', () => {
  const { getChannelLogo } = require('../src/services/ChannelLogoService');
  const logoMap = require('../src/data/tv_logos_map.json');

  test('the curated map contains no URL-breaking characters', () => {
    // A bare '%' is not a valid percent-escape and made jsDelivr answer 400 for
    // that one asset. Everything else in the map audited clean (9,897 assets).
    const bad = Object.values(logoMap).filter((v) => /%(?![0-9A-Fa-f]{2})/.test(v));
    expect(bad).toEqual([]);
  });

  test('the previously broken ukraine asset is percent-encoded', () => {
    const hit = Object.entries(logoMap).find(([, v]) => /100%25-news-ua.png$/.test(v));
    expect(hit).toBeTruthy();
    expect(Object.values(logoMap).some((v) => /100%-news-ua.png$/.test(v))).toBe(false);
  });

  test('channels whose upstream spelling differs from the curated key still resolve', () => {
    // These returned null before the fuzzy matcher and rendered logo-less.
    const cases = [
      ['Altitude', /altitude-sports/],
      ['Canal 11', /canal11-pt/],
      ['Canal Foot', /canal-plus-foot/],
      ['Canal Sport', /canal-plus-sport/],
      ['Canal Sport 2', /canal-plus-sport-2/],
      ['Canal Sport360', /canal-plus-sport-360/],
      ['Euro Sport 1', /eurosport-1/],
      ['Euro Sport 2', /eurosport-2/],
      ['Nova Sports Premier League Greece', /nova-sports-1-gr/],
      ['Chicago Sports Network', /nbc-sports-chicago/]
    ];
    for (const [title, re] of cases) {
      const url = getChannelLogo(title);
      expect(url).toBeTruthy();
      expect(url).toMatch(re);
    }
  });

  test('a lone generic token never auto-resolves to an unrelated feed', () => {
    // "Canal" must not become canal-4-ar and "Network" must not become
    // network-10-au; only the curated/alias tables may map these.
    for (const t of ['Canal', 'Sport', 'Sports', 'Network', 'Channel', 'Plus', 'TV']) {
      expect(getChannelLogo(t)).toBeNull();
    }
  });

  test('the fuzzy matcher did not regress existing resolutions', () => {
    const cases = [
      ['ESPN', /espn-us/],
      ['CNN', /cnn-us/],
      ['Sky Sports F1', /sky-sports-f1-uk/],
      ['NBA TV', /nba-tv-us/],
      ['MASN', /masn-us/],
      ['SEC Network', /sec-network-us/],
      ['DAZN 2', /dazn-2/],
      ['truTV', /tru-tv-us/]
    ];
    for (const [title, re] of cases) {
      const url = getChannelLogo(title);
      expect(url).toBeTruthy();
      expect(url).toMatch(re);
    }
  });
});

describe('24/7 channels are not re-tagged into sport rows', () => {
  test('StreamedPk keeps every 24/7 channel under "networks"', () => {
    // Re-tagging 24/7 channels with a sport (e.g. "Tennis Channel" -> tennis,
    // "Fox Cricket" -> cricket) put channel entries into the Live fixture rows.
    const source = fs.readFileSync(require.resolve('../src/providers/StreamedPkProvider'), 'utf8');
    expect(source).toContain("const finalCategory = is247Channel ? 'networks' : this.normalizeCategory(item.category);");
    // The old per-title sport re-tagging must be gone.
    expect(source).not.toContain("else if (titleLower.includes('tennis') || idLower.includes('tennis')) finalCategory = 'tennis';");
  });
});

describe('curated artwork references no dead URLs', () => {
  const svc = new TeamLogoService();

  // Every URL here returned HTTP 404 from its host when this suite was written,
  // which made the synchronous getCachedLogo() path embed a broken image and
  // skip the working dynamic lookup.
  const DEAD_URL_FRAGMENTS = [
    'soccer/500/2054.png',            // UEFA Europa League
    'soccer/500/20700.png',           // UEFA Conference League
    'countries/international/motogp.png',
    'teamlogos/leagues/500/racing.png',
    'leaguelogos/basketball/500/euroleague.png',
    'teamlogos/leagues/500/ncaa.png',
    'league/badge/28p86h1568285559.png',   // Wimbledon
    'league/badge/7a7nfs1568285642.png',   // US Open
    'league/badge/french-open.png',
    'league/badge/australian-open.png',
    'badge/c8srrm1679948011.png',     // Liverpool
    'badge/xzqdr11517660295.png',     // Manchester United
    'badge/df27491689791404.png',     // Tottenham
    'badge/3lffk81716960309.png',     // Atletico
    'badge/1kewfe1679948281.png',     // Dortmund
    'badge/7v9o0w1597161680.png',     // Juventus
    'badge/c9m0u21625754854.png',     // Inter
    'badge/usupty1473502931.png',     // AC Milan
    'badge/5ih8f51597161580.png',     // Warriors
    'badge/0532291597161528.png',     // Celtics
    'badge/w76s721561490635.png',     // Mercedes
    'badge/8s3bcf1561490610.png'      // McLaren
  ];

  test('no known-dead URL remains in the curated maps', () => {
    const source = fs.readFileSync(require.resolve('../src/services/TeamLogoService'), 'utf8');
    const stale = DEAD_URL_FRAGMENTS.filter((f) => source.includes(f));
    expect(stale).toEqual([]);
  });

  test('every curated URL is https', () => {
    const source = fs.readFileSync(require.resolve('../src/services/TeamLogoService'), 'utf8');
    const urls = [...source.matchAll(/'(https?:[^']+)'/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(40);
    expect(urls.filter((u) => !u.startsWith('https://'))).toEqual([]);
  });

  test('the previously-working curated entries still resolve', () => {
    expect(svc.getCachedLogo('Arsenal')).toContain('uyhbfe1612467038.png');
    expect(svc.getCachedLogo('Real Madrid')).toContain('vwvwrw1473502969.png');
    expect(svc.getCachedLogo('Los Angeles Lakers')).toContain('d8uoxw1714254511.png');
    expect(svc.getCachedLogo('Barca')).toContain('wq9sir1639406443.png');
    expect(svc.getCachedLogo('PSG')).toContain('rwqrrq1473504808.png');
  });

  test('repaired entries resolve to their new verified badges', () => {
    expect(svc.getCachedLogo('Liverpool')).toContain('kfaher1737969724.png');
    expect(svc.getCachedLogo('Manchester United')).toContain('xzqdr11517660252.png');
    expect(svc.getCachedLogo('Tottenham Hotspur')).toContain('dfyfhl1604094109.png');
    expect(svc.getCachedLogo('Atletico Madrid')).toContain('0ulh3q1719984315.png');
    expect(svc.getCachedLogo('Borussia Dortmund')).toContain('tqo8ge1716960353.png');
    expect(svc.getCachedLogo('Juventus')).toContain('uxf0gr1742983727.png');
    expect(svc.getCachedLogo('Inter Milan')).toContain('ryhu6d1617113103.png');
    expect(svc.getCachedLogo('AC Milan')).toContain('wvspur1448806617.png');
    expect(svc.getCachedLogo('Golden State Warriors')).toContain('xokycb1778197905.png');
    expect(svc.getCachedLogo('Boston Celtics')).toContain('4j85bn1667936589.png');
    expect(svc.getCachedLogo('Mercedes AMG')).toContain('96kai71734120813.png');
    expect(svc.getCachedLogo('McLaren')).toContain('5k3mwe1749225165.png');
  });

  test('repaired league emblems resolve', () => {
    expect(svc.getLeagueLogo('UEFA Europa League')).toContain('2310.png');
    expect(svc.getLeagueLogo('UEFA Conference League')).toContain('20296.png');
    expect(svc.getLeagueLogo('NASCAR')).toContain('ESPN-icon-NASCAR');
    expect(svc.getLeagueLogo('IndyCar')).toContain('indycar_series');
    expect(svc.getLeagueLogo('NCAA Football')).toContain('ESPN-icon-football-college');
    expect(svc.getLeagueLogo('College Football Playoffs')).toContain('ESPN-icon-football-college');
  });

  test('entries without a verified emblem are omitted, not dead', () => {
    expect(svc.getLeagueLogo('EuroLeague Basketball')).toBeNull();
    expect(svc.getLeagueLogo('Wimbledon 2026')).toBeNull();
    expect(svc.getLeagueLogo('US Open Final')).toBeNull();
    expect(svc.getLeagueLogo('Roland Garros')).toBeNull();
    expect(svc.getLeagueLogo('Australian Open')).toBeNull();
  });
});
