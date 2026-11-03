'use strict';

const crypto = require('crypto');
const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const impitClient = require('../impitClient');
const { BASE_URL } = require('../config');
const { tokenCache } = require('../routes/scoreZoneStream');

const SCOREZONE_API_BASE = 'https://testscore.pxxl.pro';
const SCOREZONE_HEADERS = {
  'Origin': 'https://scorezonetv.live',
  'Referer': 'https://scorezonetv.live/'
};

const SPORT_API_MAP = {
  football: 'soccer',
  basketball: 'basketball',
  hockey: 'hockey',
  tennis: 'tennis',
  cricket: 'cricket',
  baseball: 'baseball',
  motorsport: 'motorsport',
  mma: 'boxing',
  rugby: 'rugby-union',
  golf: 'golf',
};

const WHITELIST_KEY_MAP = {
  football: 'football',
  basketball: 'basketball',
  hockey: 'hockey',
  tennis: 'tennis',
  cricket: 'cricket',
  baseball: 'baseball',
  motorsport: 'motor-sports',
  mma: 'fight',
  rugby: 'rugby',
  golf: 'golf',
};

// Curated league whitelist extracted from the official client
const Tt = {
  football: [
    ["England", "Premier League"],
    ["Spain", "LaLiga|La Liga"],
    ["France", "Ligue 1"],
    ["Italy", "Serie A"],
    ["England", "Championship|EFL Championship"],
    ["Scotland", "Premiership"],
    ["Spain", "LaLiga 2|Segunda Division"],
    ["Brazil", "Serie A"],
    ["Romania", "Liga 1|Liga I|Superliga"],
    ["Greece", "Super League"],
    ["Denmark", "Superliga"],
    ["Portugal", "Primeira Liga|Liga Portugal"],
    ["Argentina", "Primera Division|Liga Profesional"],
    ["Netherlands", "Eredivisie"],
    ["Austria", "Bundesliga|Cup|OFB Cup"],
    ["Scotland", "FA Cup|Scottish Cup"],
    ["England", "League One"],
    ["France", "Ligue 2"],
    ["Germany", "2 Bundesliga|Bundesliga 2"],
    ["", "Copa Sudamericana|Copa Libertadores"],
    ["Australia", "A League|A League Men"],
    ["Poland", "Ekstraklasa"],
    ["Germany", "Bundesliga|DFB Pokal"],
    ["", "Champions League|Europa League|Conference League"],
    ["Saudi Arabia", "Pro League|Saudi Pro League"],
    ["Turkiye|Turkey", "Super Lig"],
    ["Belgium", "Pro League|First Division A"],
    ["Switzerland", "Super League"],
    ["USA|United States", "MLS"],
    ["Spain", "Copa del Rey"],
    ["England", "EFL Cup|EFL Trophy"],
    ["Portugal", "Taca da Liga|League Cup"],
    ["Denmark", "DBU Pokalen|Cup"],
    ["Greece", "Cup|Greek Cup"],
    ["Netherlands", "KNVB Cup|Cup"]
  ],
  basketball: [["", "Euroleague|NBA|WNBA|NCAA|NCAA Basketball|NCAA Men|NCAA Women"]],
  "american-football": [["", "NFL|NCAA|College Football"]],
  hockey: [["", "NHL"]],
  baseball: [["", "MLB"]],
  "motor-sports": [["", "Formula 1|Formula One|MotoGP"]],
  fight: [["", "UFC|Boxing|WWE|AEW|TNA Wrestling|NJPW|PFL|ONE Championship|BKFC|Oktagon MMA"]],
  tennis: [["", "ATP|ATP World Tour"]],
  rugby: [["", "English Prem Rugby|Premiership|United Rugby Championship|Top 14|Super Rugby|Rugby World Cup|Six Nations|Rugby Championship|Autumn Nations Cup|Currie Cup|National Provincial Championship|Internationals|Rugby Union Internationals|Rugby League World Cup|NRL|Super League|State of Origin"]],
  golf: [["", "PGA Tour"]],
  cricket: [["", "International Test Match|Test Series|Test Matches|ODI Series|One Day Internationals|T20I Series|Twenty20 Internationals|ICC World Test Championship|Big Bash League|The Hundred|SA20|Caribbean Premier League"]]
};

const re = t => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function isWhitelistedStage(whitelistKey, stage) {
  const rules = Tt[whitelistKey];
  if (!rules) return ['billiards', 'afl', 'darts', 'other'].includes(whitelistKey);
  const r = [stage.Snm, stage.CompN].map(re);
  const n = re(stage.Cnm);
  return rules.some(([countryRule, leagueRule]) =>
    (!countryRule || countryRule.split('|').some(c => re(c) === n)) &&
    leagueRule.split('|').some(l => r.some(h => h === re(l) || h.startsWith(`${re(l)} `)))
  );
}

function getUtcDateStrings() {
  const now = new Date();
  const d0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const d1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const toYmd = d => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };
  return [toYmd(d0), toYmd(d1)];
}

class ScoreZoneProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'ScoreZone';
    this._warnedNoSecret = false;
    this._channelCache = new Map();
    this._channelInFlight = new Map();

    if (this.circuitBreaker) {
      this.fetchMatches = this.circuitBreaker.wrapSync(`${this.name}_fetchMatches`, async () => {
        return this.getMatches();
      });
      this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (sourceId, category, title, src) => {
        return this.resolveStream(sourceId, category, title, src);
      });
    }
  }


  async proxyFetch(url, options = {}) {
    return impitClient.safeFetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: options.signal,
      timeoutMs: options.timeoutMs || 8000,
      attempts: options.attempts,
    });
  }

  isEnabled() {
    return process.env.SCOREZONE_ENABLED === 'true';
  }

  _getSecret() {
    return this.secret || process.env.APP_SECRET || process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'scorezone-dev-default-secret');
  }

  async getMatches() {
    const dates = getUtcDateStrings();
    const allLeagues = process.env.SCOREZONE_ALL_LEAGUES === 'true';
    const secret = this._getSecret();

    const tasks = [];
    for (const [cat, apiSport] of Object.entries(SPORT_API_MAP)) {
      for (const dateStr of dates) {
        tasks.push({ cat, apiSport, dateStr });
      }
    }

    const fetchPromises = tasks.map(async ({ cat, apiSport, dateStr }) => {
      const url = `${SCOREZONE_API_BASE}/api/livescore/${apiSport}/${dateStr}`;
      const res = await this.proxyFetch(url, {
        headers: SCOREZONE_HEADERS,
        timeoutMs: 8000,
      });

      if (!res || !res.ok) {
        throw new Error(`ScoreZone HTTP ${res ? res.status : 'timeout'} for ${apiSport}/${dateStr}`);
      }

      const data = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
      if (!data || !Array.isArray(data.Stages)) {
        throw new Error(`ScoreZone malformed payload (missing Stages) for ${apiSport}/${dateStr}`);
      }

      return { cat, apiSport, data };
    });

    const results = await Promise.allSettled(fetchPromises);
    const hasMalformedSchema = results.some(r => r.status === 'rejected' && r.reason?.message?.includes('missing Stages'));
    const fulfilled = results.filter(r => r.status === 'fulfilled');

    if (hasMalformedSchema || fulfilled.length === 0) {
      throw new Error('ScoreZone livescore sync failed across all sports');
    }

    const seenEids = new Set();
    const matches = [];

    for (const res of fulfilled) {
      const { cat, data } = res.value;
      const whitelistKey = WHITELIST_KEY_MAP[cat] || cat;

      for (const stage of data.Stages) {
        if (!allLeagues && !isWhitelistedStage(whitelistKey, stage)) {
          continue;
        }

        const events = Array.isArray(stage.Events) ? stage.Events : [];
        for (const event of events) {
          if (!event.Eid || seenEids.has(String(event.Eid))) {
            continue;
          }

          const esdStr = String(event.Esd || '');
          if (!/^\d{14}$/.test(esdStr)) {
            continue;
          }

          const startMs = Date.UTC(
            +esdStr.slice(0, 4),
            +esdStr.slice(4, 6) - 1,
            +esdStr.slice(6, 8),
            +esdStr.slice(8, 10),
            +esdStr.slice(10, 12),
            +esdStr.slice(12, 14)
          );

          const home = typeof event.T1 === 'string'
            ? event.T1
            : (Array.isArray(event.T1) ? event.T1[0]?.Nm : event.T1?.Nm) || '';
          const away = typeof event.T2 === 'string'
            ? event.T2
            : (Array.isArray(event.T2) ? event.T2[0]?.Nm : event.T2?.Nm) || '';

          if (!home && !away) {
            continue;
          }

          const title = away ? `${home} vs ${away}` : home;
          seenEids.add(String(event.Eid));

          const payload = {
            h: home,
            a: away,
            s: cat,
            c: stage.CompN || stage.Cnm || '',
            e: String(event.Eid),
            t: startMs,
          };
          const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
          const sig = secret
            ? crypto.createHmac('sha256', secret).update(b64).digest('hex').slice(0, 16)
            : '';
          const sourceId = `${b64}.${sig}`;

          matches.push(new MatchEntity({
            id: `scorezone_${event.Eid}`,
            title,
            category: cat,
            date: String(startMs),
            league: stage.CompN || stage.Snm || stage.Cnm || '',
            team1: { name: home },
            team2: { name: away },
            sources: [{ source: 'scorezone', id: sourceId }]
          }));
        }
      }
    }

    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src) {
    const secret = this._getSecret();
    if (!secret) {
      if (!this._warnedNoSecret) {
        console.warn('[ScoreZone] APP_SECRET/SESSION_SECRET unset: HMAC generation disabled, returning 0 streams');
        this._warnedNoSecret = true;
      }
      return [];
    }

    if (!sourceId || typeof sourceId !== 'string') return [];
    const lastDot = sourceId.lastIndexOf('.');
    if (lastDot === -1) return [];

    const b64 = sourceId.slice(0, lastDot);
    const sig = sourceId.slice(lastDot + 1);

    const expected = crypto.createHmac('sha256', secret).update(b64).digest('hex').slice(0, 16);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return [];
    }

    let meta;
    try {
      meta = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    } catch (_) {
      return [];
    }

    const eventId = String(meta.e || '');
    const cacheKey = eventId;
    const now = Date.now();

    const cached = this._channelCache.get(cacheKey);
    let channelsData;
    if (cached && now < cached.expiresAt) {
      channelsData = cached.data;
    } else if (this._channelInFlight.has(cacheKey)) {
      channelsData = await this._channelInFlight.get(cacheKey);
    } else {
      const fetchPromise = (async () => {
        const qs = new URLSearchParams({
          home: meta.h || '',
          away: meta.a || '',
          sport: meta.s || matchCategory || 'football',
          eventId,
          ...(meta.t ? { start: String(meta.t) } : {}),
          ...(meta.c ? { competition: meta.c } : {})
        }).toString();

        const url = `${SCOREZONE_API_BASE}/api/matches/channels?${qs}`;
        const res = await this.proxyFetch(url, {
          headers: SCOREZONE_HEADERS,
          timeoutMs: 8000,
        });

        if (!res || !res.ok) {
          return null;
        }

        const data = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
        if (!data || !Array.isArray(data.channels)) {
          throw new Error('ScoreZone malformed channels payload');
        }

        this._channelCache.set(cacheKey, { data, expiresAt: Date.now() + 60000 });
        return data;
      })();

      this._channelInFlight.set(cacheKey, fetchPromise);
      try {
        channelsData = await fetchPromise;
      } finally {
        this._channelInFlight.delete(cacheKey);
      }
    }

    if (!channelsData || !Array.isArray(channelsData.channels)) {
      return [];
    }

    if (channelsData.key && Array.isArray(channelsData.channels)) {
      for (const ch of channelsData.channels) {
        tokenCache.set(`${meta.e}:${ch.id}`, {
          matchKey: channelsData.key,
          meta,
          createdAt: Date.now()
        });
      }
    }

    const unlocked = channelsData.channels.filter(c => !c.locked);
    const effectiveSourceId = src ? src.id : sourceId;

    return unlocked.map(ch => new StreamEntity({
      name: 'ScoreZone',
      title: `ScoreZone | ${ch.name}${ch.quality ? ' — ' + ch.quality : ''}`,
      url: `${BASE_URL}/api/scorezone/manifest/${encodeURIComponent(effectiveSourceId)}/${encodeURIComponent(ch.id)}.m3u8`,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            'Referer': 'https://scorezonetv.live/',
            'Origin': 'https://scorezonetv.live',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          }
        }
      },
      sourceName: 'scorezone',
      _source: 'scorezone'
    }));
  }
}

module.exports = ScoreZoneProvider;
module.exports.Tt = Tt;
module.exports.isWhitelistedStage = isWhitelistedStage;
module.exports.SPORT_API_MAP = SPORT_API_MAP;
