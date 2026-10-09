// ─── Fuzzy Match Helpers ────────────────────────────────────────────────────

// How long past kickoff a ReplayZone archive session is retained in the
// aggregated cache. Bounds replay list growth; other providers keep the
// standard 24h window.
const REPLAY_RETENTION_DAYS = 30;

const { parseTimezone } = require('../timezone');

/**
 * Parses a provider-supplied match date into epoch milliseconds.
 *
 * Providers are inconsistent: most send a numeric epoch (as number or numeric
 * string), but ReplayZone sends ISO date strings ("2026-09-14"). A plain
 * Number() cast turns those into NaN, which the caller then coerces to 0 -
 * silently disabling the date-window guard in _sameEventPre. That guard is what
 * stops the same fixture on different days from merging, so losing it merges
 * unrelated events (observed: a "Chicago Cubs @ Atlanta Braves" replay from May
 * merged into the September Cubs vs Braves fixture, attaching replay streams to
 * a live/upcoming listing).
 *
 * Parsing goes through the shared timezone parser rather than raw Date.parse.
 * Date.parse resolves an unqualified string such as "2026-09-14T20:00:00.000"
 * in the HOST zone, so the merge guard disagreed with the display path
 * (getKickoff) whenever the server was not on UTC - a silent multi-hour skew on
 * the merge window. The shared parser treats unqualified input as UTC, keeping
 * both paths consistent and host-independent.
 */
function _parseEventDate(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isNaN(n) && Number.isFinite(n) && n > 0) return n;
  const str = String(raw).trim();
  if (!str) return 0;
  const parsed = parseTimezone(str, 'UTC');
  if (parsed && !Number.isNaN(parsed) && parsed > 0) return parsed;
  // Last resort for non-ISO shapes (e.g. "September 14, 2026").
  const fallback = Date.parse(str);
  return Number.isNaN(fallback) ? 0 : fallback;
}

/**
 * Normalizes team/event names by collapsing well-known multi-word clubs and
 * popular abbreviations into single collision-safe compound tokens so that
 * Jaccard / subset matching cannot accidentally merge different teams that share
 * a single word (e.g. "Inter Milan" vs "AC Milan" both contain "milan").
 *
 * ORDER MATTERS: more specific aliases (inter miami, inter turku) must come
 * before the bare-"inter" rule, otherwise "Inter Miami" would compound to
 * "intermilan" and collide with Inter Milan.
 */
function _compoundify(t) {
  const aliases = [
    // Motorsport — Formula 1 / F1 must come FIRST so the "1" never becomes a
    // stray digit that blocks e.g. "Formula 1 Azerbaijan GP" from merging with
    // "Azerbaijan Grand Prix". "GP" also normalised to "grandprix" to help
    // track-event titles collapse regardless of whether GP is spelled out.
    [/\bformula\s*(?:one|1)\b|\bf[- ]?1\b/g, 'formulaone'],
    [/\bgrand\s*prix\b|\bgp\b/g, 'grandprix'],
    // Football (Soccer)
    [/\bman(chester)?\s*utd\b|\bmanchester\s*united\b/g, 'manchesterunited'],
    [/\bman\.?\s+united\b/g, 'manchesterunited'], // "Man United" / "Man. United" (gap found by A/B testing)
    [/\bman(chester)?\s*city\b/g, 'manchestercity'],
    [/\bspurs\b|\btottenham(\s*hotspur)?\b/g, 'tottenham'],
    [/\bwolves\b|\bwolverhampton(\s*wanderers)?\b/g, 'wolverhampton'],
    [/\bpsg\b|\bparis\s*(saint|st)\s*germain\b/g, 'psg'],
    [/\bbayern(\s*m[uü]nchen)?\b|\bbayern\s*munich\b/g, 'bayernmunich'],
    [/\batl(etico)?\s*madrid\b/g, 'atleticomadrid'],
    [/\breal\s*madrid\b|\br\s*madrid\b/g, 'realmadrid'],
    // inter variants must precede the bare-inter rule below
    [/\binter\s*miami\b/g, 'intermiami'],
    [/\binter\s*turku\b/g, 'interturku'],
    [/\binter(\s*milan)?\b|\binternazionale\b/g, 'intermilan'],
    [/\bac\s*milan\b/g, 'acmilan'],
    [/\bborussia\s*dortmund\b|\bbvb\b|\bdortmund\b/g, 'borussiadortmund'],
    [/\brb\s*leipzig\b/g, 'rbleipzig'],
    [/\baston\s*villa\b/g, 'astonvilla'],
    [/\bwest\s*ham(\s*united)?\b/g, 'westham'],
    [/\bcrystal\s*palace\b/g, 'crystalpalace'],
    [/\bnewcastle(\s*united)?\b/g, 'newcastle'],
    [/\bnottingham\s*forest\b|\bnott(?:s|m)\s+forest\b/g, 'nottinghamforest'],
    [/\bleicester(\s*city)?\b/g, 'leicestercity'],
    [/\bsheff(?:ield)?\s*(?:utd|united)\b/g, 'sheffieldunited'],
    [/\bbe(?:in\s*sport|\s*in)\b/g, 'beinsport'],
    [/\bal[\s\-]nassr\b/g, 'alnassr'],
    [/\bal[\s\-]hilal\b/g, 'alhilal'],
    [/\bal[\s\-]ahly\b/g, 'alahly'],
    [/\bboca\s*juniors\b|\bca\s*boca\b/g, 'bocajuniors'],
    // American Football
    [/\bkansas\s*city\s*chiefs\b|\bkc\s*chiefs\b|\bchiefs\b/g, 'kansascitychiefs'],
    [/\bseattle\s*seahawks\b|\bseahawks\b/g, 'seattleseahawks'],
    [/\bsan\s*francisco\s*49ers\b|\bniners\b|\b49ers\b/g, 'sf49ers'],
    [/\bdallas\s*cowboys\b|\bcowboys\b/g, 'dallascowboys'],
    [/\bphiladelphia\s*eagles\b|\beagles\b/g, 'philadelphiaeagles'],
    [/\bgreen\s*bay\s*packers\b|\bpackers\b/g, 'greenbaypacker'],
    [/\bcincinatti\s*bengals\b|\bbengals\b/g, 'cincinnatibengals'],
    [/\bpittsburgh\s*steelers\b|\bsteelers\b/g, 'pittsburghsteelers'],
    // Cricket Channels
    [/\bwillow(?:\s*2)?(?:\s*cricket)?\b/gi, 'willowcricket'],
    [/\bfox\s*cricket\b/gi, 'foxcricket'],
    // Basketball — NBL (Australia) teams
    [/\bperth\s*wildcats\b/g, 'perthwildcat'],
    [/\badelaide\s*36ers\b/g, 'adelaide36er'],
    [/\bmelbourne\s*united\b/g, 'melbourneunited'],
    [/\bsydney\s*kings\b/g, 'sydneyking'],
    [/\bbrisbane\s*bullets?\b/g, 'brisbanebullet'],
    [/\bnz\s*breakers?\b|\bnew\s*zealand\s*breakers?\b/g, 'nzbreaker'],
    [/\bsouth\s*east\s*melbourne\s*phoenix\b|\bse\s*melbourne\b/g, 'semelbournephoenix'],
    [/\btasmania\s*jackjumpers?\b/g, 'tasmaniajackjumper'],
    [/\bcairns\s*taipans?\b/g, 'cairnstaispan'],
    [/\bilawarra\s*hawks?\b/g, 'ilawarrahawk'],
    // NBA teams
    [/\bny\s*knicks\b|\bnew\s*york\s*knicks\b|\bknicks\b/g, 'nyknicks'],
    [/\bboston\s*celtics\b|\bceltics\b/g, 'bostonceltics'],
    [/\bla\s*lakers\b|\blakers\b|\blos\s*angeles\s*lakers\b/g, 'lalakers'],
    [/\bgolden\s*state\s*warriors\b|\bwarriors\b/g, 'gswarriors'],
    [/\bchicago\s*bulls\b|\bbulls\b/g, 'chicagobulls'],
    [/\bmiami\s*heat\b|\bheat\b/g, 'miamiheat'],
    [/\bdenver\s*nuggets\b|\bnuggets\b/g, 'denvernuggets'],
    [/\bmilwaukee\s*bucks\b|\bbucks\b/g, 'milwaukeebucks'],
  ];
  let r = t.toLowerCase();
  for (const [regex, rep] of aliases) r = r.replace(regex, rep);
  return r;
}

function _stripNoise(t) {
  return t
    .replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(live|stream|streaming|free|hd|fhd|4k|hq|web|online|tv|match|fixture|round|week|day|game|league|cup|tournament|season|fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv)\b/gi, ' ');
}

function _tokenize(t) {
  return t.replace(/[^a-z0-9]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w); // naive singular: newells->newell, sports->sport
}

/**
 * Determine if two team-name strings refer to the same club.
 * Single compound tokens (e.g. "manchestercity") require exact equality so
 * different compounds cannot accidentally match via substring.
 */
function _teamsSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const at = a.split(' ').filter(w => w.length > 2);
  const bt = b.split(' ').filter(w => w.length > 2);
  if (at.length === 0 || bt.length === 0) return false;
  if (at.length === 1 && bt.length === 1) return at[0] === bt[0];
  const sa = new Set(at), sb = new Set(bt);
  let common = 0;
  for (const w of sa) if (sb.has(w)) common++;
  const minLen = Math.min(sa.size, sb.size);
  return minLen > 0 && (common / minLen) >= 0.7;
}

/**
 * Try to split a match title into [team1, team2] using common separators.
 * Returns null if the title doesn't look like a "team1 vs team2" fixture.
 */
function _tryExtractTeams(title) {
  const clean = _compoundify(_stripNoise(title));
  const parts = clean.split(/\s(?:vs?\.?|@|[-–—])\s/i);
  if (parts.length === 2) {
    return [_tokenize(parts[0]).join(' '), _tokenize(parts[1]).join(' ')];
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────

const { extractTeamsFromTitle } = require('./TeamNameExtractor');

class MatchAggregator {
  constructor({ timStreamsProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamedPkProvider, cacheService, yamlProviders, replayzoneProvider, daddyLiveProvider, teamLogoService, liveTvProvider, damiTvProvider, ppvStProvider }) {
    this.providers = [timStreamsProvider, streamedPkProvider, watchFootyProvider, cdnLiveProvider, ...(yamlProviders || []), replayzoneProvider, ...(liveTvProvider ? [liveTvProvider] : []), ...(daddyLiveProvider ? [daddyLiveProvider] : []), ...(damiTvProvider ? [damiTvProvider] : []), ...(ppvStProvider ? [ppvStProvider] : [])];
    this.streamSports99Provider = streamSports99Provider;
    this.cacheService = cacheService;
    this.teamLogoService = teamLogoService;
  }

  /**
   * Precompute everything isSameEvent needs ONCE per match. The merge loop is
   * O(N^2) in pair comparisons; doing the regex-heavy normalization here instead
   * of inside every comparison removes ~50x of repeated work on large catalogs.
   */
  _precompute(e) {
    const title = e && e.title ? String(e.title) : '';
    const id = e && e.id != null ? String(e.id) : '';
    const normalized = _compoundify(_stripNoise(title));
    return {
      id,
      category: e && e.category ? String(e.category) : '',
      date: _parseEventDate(e && e.date),
      teams: _tryExtractTeams(title),
      tokens: new Set(_tokenize(normalized).filter(w => { const n = Number(w); return !(n >= 2000 && n <= 2100); })),
      norm: normalized.replace(/\s+/g, ' ').trim(),
      // Extract digits from the NORMALIZED form so compound tokens like
      // "formulaone" don't leave a stray "1". Also strip 4-digit calendar
      // years (2020–2099) since providers sometimes brand titles with the
      // season year and it must not block merging with un-branded twins.
      digits: (normalized.match(/\d+/g) || [])
        .filter(d => { const n = Number(d); return !(n >= 2000 && n <= 2100); })
        .sort()
        .join(',')
    };
  }

  /**
   * Merge decision on precomputed matches. Same decision tree as before, with
   * two fixes found by A/B testing against the real catalog:
   *   - "Man United" style alias gap (same match, two catalog names)
   *   - channel-like titles (no team-vs-team parse) collapsing under a loose
   *     Jaccard rule ("Sky Sports F1" + "Sky Sports Main Event" merged;
   *     "US Open Court 13" + "Court 7" merged)
   */
  _sameEventPre(p1, p2) {
    // 1. Category mismatch guard
    // Some providers use league-specific slugs (nbl, nba, nfl, mls, nrl, afl)
    // while others use the parent sport name (basketball, american_football,
    // football, rugby). Normalise both to the parent before comparing so the
    // same fixture from two different providers isn't blocked by the guard.
    const _normalizeCategory = (c) => {
      if (!c) return c;
      const lc = c.toLowerCase();
      if (['nbl', 'nba', 'wnba', 'euroleague', 'ncaa_basketball'].includes(lc)) return 'basketball';
      if (['nfl', 'ncaa', 'cfl', 'college'].includes(lc)) return 'american_football';
      if (['nrl', 'super_league', 'afl', 'rugby_league', 'rugby_union', 'rugby15'].includes(lc)) return 'rugby';
      if (['mls', 'epl', 'la_liga', 'bundesliga', 'serie_a', 'ligue_1', 'ucl', 'uel'].includes(lc)) return 'football';
      if (['formula_1', 'formulaone', 'motogp', 'indycar', 'nascar'].includes(lc)) return 'motorsport';
      if (['mlb', 'npb'].includes(lc)) return 'baseball';
      if (['nhl', 'khl', 'ice hockey', 'ice_hockey', 'icehockey'].includes(lc)) return 'hockey';
      if (['sports', 'sport', 'networks'].includes(lc)) return 'other';
      return lc;
    };
    const c1 = _normalizeCategory(p1.category);
    const c2 = _normalizeCategory(p2.category);
    const isCollegeFootball = ((p1.category || '').toLowerCase() === 'college' && (c2 === 'american_football' || c2 === 'football')) ||
                              ((p2.category || '').toLowerCase() === 'college' && (c1 === 'american_football' || c1 === 'football'));
    if (c1 && c2 && c1 !== 'other' && c2 !== 'other' && c1 !== c2 && !isCollegeFootball) {
      return false;
    }
    // 2. Exact ID match
    if (p1.id && p2.id && p1.id === p2.id) return true;
    // 3. Date window guard — events more than 24h apart are definitely different
    if (p1.date && p2.date && Math.abs(p1.date - p2.date) > 86400000) return false;

    // 5. Dual-team extraction — if both titles parse as "team1 vs team2", require
    //    BOTH teams to independently fuzzy-match. (Skip for motorsport which has no teams).
    if (p1.teams && p2.teams && c1 !== 'motorsport' && c2 !== 'motorsport') {
      const fwd = _teamsSimilar(p1.teams[0], p2.teams[0]) && _teamsSimilar(p1.teams[1], p2.teams[1]);
      const rev = _teamsSimilar(p1.teams[0], p2.teams[1]) && _teamsSimilar(p1.teams[1], p2.teams[0]);
      return fwd || rev;
    }

    // 6. Channel-identity path — at least one title is not a team-vs-team fixture
    //    (24/7 channels, court/track numbered events, "Team Live" listings).
    if (p1.tokens.size === 0 || p2.tokens.size === 0) return false;

    // Digit signatures must agree: "beIN 1" vs "beIN 2", "Court 13" vs "Court 7"
    // are different channels/events even when the words are identical. (Skip for motorsport Grand Prix).
    const isGrandPrix = (t) => t.has('grandprix') || t.has('gp') || t.has('formulaone') || t.has('motogp') || t.has('nascar') || t.has('rally');
    const cIsMoto = c1 === 'motorsport' || c2 === 'motorsport';
    if (!cIsMoto || !(isGrandPrix(p1.tokens) && isGrandPrix(p2.tokens))) {
      if (p1.digits !== p2.digits) return false;
    }

    // 6a. One fixture + one channel-like listing: the channel-like tokens must be
    //     a subset of the fixture tokens ("Real Madrid live" ⊂ "Real Madrid vs
    //     Barcelona"). This keeps single-team listings merging with the fixture.
    if ((p1.teams || p2.teams) && !cIsMoto) {
      const channel = p1.teams ? p2 : p1;
      const fixture = p1.teams ? p1 : p2;
      for (const w of channel.tokens) if (!fixture.tokens.has(w)) return false;
      return true;
    }

    // 6b. Both channel-like: strict identity only. Distinct channels with shared
    //     branding must never merge.
    if (p1.norm === p2.norm) return true;

    // 6c. Motorsport specific fallback: Formula 1, MotoGP, etc.
    // e.g. "Bahrain Grand Prix - Race" vs "Formula 1 Bahrain Grand Prix in Malaysia"
    if (c1 === 'motorsport' || c2 === 'motorsport') {
      const isGrandPrix = (t) => t.has('grandprix') || t.has('gp') || t.has('formulaone') || t.has('motogp') || t.has('nascar') || t.has('rally');
      if (isGrandPrix(p1.tokens) && isGrandPrix(p2.tokens)) {
        const generics = new Set(['grandprix', 'gp', 'formulaone', 'f1', 'motogp', 'nascar', 'rally', 'race', 'sunday', 'saturday', 'friday', 'practice', 'qualifying', 'sprint', 'championship', 'world', 'cup']);
        const specificShared = [...p1.tokens].filter(x => p2.tokens.has(x) && !generics.has(x) && isNaN(x));
        if (specificShared.length >= 1) return true;
      }
    }

    // Subset check: if one token set is entirely contained in the other (minimum
    // 2 content tokens), the narrower title is a refinement of the broader one.
    // e.g. {"azerbaijan","grandprix"} ⊂ {"formulaone","azerbaijan","grandprix"}
    // This handles "Azerbaijan Grand Prix" vs "Formula 1 Azerbaijan Grand Prix".
    // Safety: Monaco GP and Azerbaijan GP share only "grandprix" (1 token) so
    // the minimum-2 guard keeps them separate.
    const smaller = p1.tokens.size <= p2.tokens.size ? p1 : p2;
    const larger  = p1.tokens.size <= p2.tokens.size ? p2 : p1;
    if (smaller.tokens.size >= 2) {
      let allIn = true;
      for (const w of smaller.tokens) { if (!larger.tokens.has(w)) { allIn = false; break; } }
      if (allIn) return true;
    }

    let common = 0;
    for (const w of p1.tokens) if (p2.tokens.has(w)) common++;
    const union = p1.tokens.size + p2.tokens.size - common;
    if (union > 0 && common / union >= 0.75) return true;
    return false;
  }

  /** Public API preserved: decision on raw matches (computes pre on the fly). */
  isSameEvent(e1, e2) {
    return this._sameEventPre(this._precompute(e1), this._precompute(e2));
  }

  async syncMatches() {
    console.log('[MatchAggregator] Fetching from all providers...');
    const finalMatches = [];
    const finalPres = []; // precomputed identity for each accepted match

    // The merge scan is O(incoming x accepted). At production scale one
    // provider's rows used to land as a single ~200ms synchronous block on the
    // event loop; every HTTP request queued behind it. Process rows in small
    // chunks and yield between chunks (setImmediate lets pending I/O callbacks
    // and queued request handlers run) so no single block exceeds ~20ms.
    const MERGE_CHUNK = Number(process.env.MERGE_CHUNK_SIZE || 25);
    const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

    const processProviderMatches = async (providerMatches) => {
      if (!providerMatches || !Array.isArray(providerMatches)) return;
      for (let start = 0; start < providerMatches.length; start += MERGE_CHUNK) {
        const end = Math.min(start + MERGE_CHUNK, providerMatches.length);
        for (let r = start; r < end; r++) {
          const match = providerMatches[r];
          if (!match.id || !match.title) continue;
          if (!match.sources || !Array.isArray(match.sources) || match.sources.length === 0) continue;

        const pre = this._precompute(match);
        let idx = -1;
        for (let i = 0; i < finalMatches.length; i++) {
          if (this._sameEventPre(finalPres[i], pre)) { idx = i; break; }
        }

        if (idx === -1) {
          finalMatches.push(match);
          finalPres.push(pre);
          continue;
        }

        const existing = finalMatches[idx];
        if (!existing.aliasIds) existing.aliasIds = [];
        if (match.id && !existing.aliasIds.includes(match.id)) {
          existing.aliasIds.push(match.id);
        }
        if (Array.isArray(match.aliasIds)) {
          for (const aid of match.aliasIds) {
            if (!existing.aliasIds.includes(aid)) existing.aliasIds.push(aid);
          }
        }
        if (match.sources && Array.isArray(match.sources)) {
          match.sources.forEach(src => {
            if (!existing.sources.find(s => s.id === src.id && s.source === src.source)) {
              existing.sources.push(src);
            }
          });
        }
        if (match.popular === '1') existing.popular = '1';
        if (!existing.poster && match.poster) existing.poster = match.poster;
        if (!existing.logo && match.logo) existing.logo = match.logo;
        if (!existing.thumbnail_url && match.thumbnail_url) existing.thumbnail_url = match.thumbnail_url;
        // Carry a live score across the merge the same way artwork is carried.
        // A later provider that reports a score wins over an earlier blank.
        if (!existing.score && match.score) existing.score = match.score;
        if (!existing.background && match.background) existing.background = match.background;
        if (!existing.league && match.league) existing.league = match.league;
        if (!existing.team1 && match.team1) existing.team1 = match.team1;
        else if (existing.team1 && !existing.team1.logo && match.team1 && match.team1.logo) existing.team1.logo = match.team1.logo;
        if (!existing.team2 && match.team2) existing.team2 = match.team2;
        else if (existing.team2 && !existing.team2.logo && match.team2 && match.team2.logo) existing.team2.logo = match.team2.logo;
        if (existing.description === 'No description' && match.description && match.description !== 'No description') {
          existing.description = match.description;
        }

        // Prefer specific 'college' category if any merged source has it
        if (existing.category !== 'college' && match.category === 'college') {
          existing.category = 'college';
          finalPres[idx].category = 'college';
        }

        // Reconcile kickoff date: if existing date is missing or 0, adopt incoming date.
        // Also prefer high-precision epoch ms from dedicated event providers (e.g. streamedpk)
        // over coarse dates.
        const existingDateMs = _parseEventDate(existing.date);
        const incomingDateMs = _parseEventDate(match.date);
        if ((!existingDateMs || existingDateMs <= 0) && incomingDateMs > 0) {
          existing.date = match.date;
          finalPres[idx].date = incomingDateMs;
        } else if (existingDateMs > 0 && incomingDateMs > 0 && match.sources && match.sources.some(s => s.source === 'streamedpk')) {
          existing.date = match.date;
          finalPres[idx].date = incomingDateMs;
        }

        // Canonical naming: prefer a team-vs-team fixture title over a
        // channel-like listing title, so the merged event keeps the most
        // informative name regardless of which provider arrived first.
        if (!existing._titleIsFixture && pre.teams) {
          existing.title = match.title;
          existing._titleIsFixture = true;
          finalPres[idx] = pre;
        }
        }
        if (end < providerMatches.length) await yieldToLoop();
      }
    };

    // Providers swallow their own errors and return []. A non-empty result is the
    // only reliable success signal; it keeps a total upstream outage from wiping the cache.
    let anyProviderSucceeded = false;

    // ── 12-Hour Replay Cadence ──────────────────────────────────────────────
    // Replay events (ReplayZone & LiveTV 21-day archives) are static past fixtures.
    // Re-scraping 21 days of Russian mirrors and archive pages on every server restart
    // or sync burns significant CPU, network, and RAM. Reuse cached replays if they
    // were synced within the last 12 hours.
    const REPLAY_PROVIDERS = new Set(['replayzone', 'livetv']);
    const REPLAY_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

    const previous = (this.cacheService && typeof this.cacheService.getMatches === 'function')
      ? this.cacheService.getMatches()
      : [];
    const previousReplays = previous.filter(m => m && m.sources && m.sources.some(s => s.source === 'replayzone' || s.source === 'livetv'));

    if (this.lastReplaySync === undefined && this.cacheService && this.cacheService.lastFetchTime) {
      this.lastReplaySync = this.cacheService.lastFetchTime;
    }

    const isReplayFresh = previousReplays.length > 0 && this.lastReplaySync && (Date.now() - this.lastReplaySync < REPLAY_SYNC_INTERVAL_MS);

    if (isReplayFresh) {
      console.log(`[MatchAggregator] Reusing ${previousReplays.length} cached replay events (synced ${Math.round((Date.now() - this.lastReplaySync) / 60000)}m ago; 12h cadence). Skipping LiveTV & ReplayZone scrape.`);
      await processProviderMatches(previousReplays);
      anyProviderSucceeded = true;
    } else {
      this.lastReplaySync = Date.now();
    }

    const providersToQuery = this.providers.filter(p => {
      const name = p.sourceName || p.name || '';
      if (REPLAY_PROVIDERS.has(name) && isReplayFresh) {
        return false;
      }
      return true;
    });

    if (process.env.LOW_MEMORY_MODE === 'true') {
      // Memory-safe sequential fetching (Alwaysdata)
      for (const p of providersToQuery) {
        try {
          const providerMatches = await p.getMatches();
          if (Array.isArray(providerMatches) && providerMatches.length > 0) anyProviderSucceeded = true;
          await processProviderMatches(providerMatches);
        } catch (err) {
          console.error(`[MatchAggregator] Provider fetch failed:`, err.message);
        }
      }
    } else {
      // Fast parallel fetching (Render / Local)
      const results = await Promise.allSettled(providersToQuery.map(p => p.getMatches()));
      for (let index = 0; index < results.length; index++) {
        const promiseResult = results[index];
        if (promiseResult.status === 'fulfilled') {
          if (Array.isArray(promiseResult.value) && promiseResult.value.length > 0) anyProviderSucceeded = true;
          await processProviderMatches(promiseResult.value);
        } else {
          console.error(`[MatchAggregator] Provider ${index} failed:`, promiseResult.reason);
        }
      }
    }

    const now = Date.now();
    // Smart Trending Engine: Boost popular matches globally, but only if they are actually live or starting soon
    const TRENDING_KEYWORDS = ['bein', 'real madrid', 'barcelona', 'manchester', 'arsenal', 'liverpool', 'chelsea', 'bayern', 'psg', 'lakers', 'warriors', 'mcgregor', 'super bowl', 'champions league', 'el clasico', 'f1', 'formula 1', 'grand prix'];

    finalMatches.forEach(match => {
      const titleLower = match.title.toLowerCase();

      // Parse kickoff date (default to 0 if none provided, assume live)
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      // Allow matches to be flagged as 'Live' from 3 hours before kickoff up to 14 hours after kickoff
      const isWithinTimeWindow = kickoff === 0 || (now >= kickoff - (3 * 3600 * 1000) && now <= kickoff + (14 * 3600 * 1000));

      if (TRENDING_KEYWORDS.some(kw => titleLower.includes(kw))) {
        if (isWithinTimeWindow) {
          match.popular = '1';
        }
      }

      // GLOBAL FIX: Some providers (like Streamed.pk) flag future events as popular/live early.
      // We must override and strip the popular flag if the event is too far in the future.
      if (match.popular === '1' && kickoff > 0 && !isWithinTimeWindow) {
        match.popular = '0';
      }
    });

    // Filter out matches that have 0 sources or are already over (kickoff was > 24 hours ago)
    const activeMatches = finalMatches.filter(match => {
      if (!match.sources || !Array.isArray(match.sources) || match.sources.length === 0) {
        return false;
      }
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      if (kickoff === 0) return true; // Keep if we don't know the time

      // Keep matches up to 24 hours after kickoff. ReplayZone entries are
      // archive sessions rather than fixtures, so they get an explicit, bounded
      // retention window instead of an open-ended exemption.
      const expiryWindowMs = 24 * 3600 * 1000;
      const replayExpiryWindowMs = REPLAY_RETENTION_DAYS * 24 * 3600 * 1000;
      const isReplayZone = match.sources && match.sources.some(s => s.source === 'replayzone' || s.source === 'livetv');
      const windowMs = isReplayZone ? replayExpiryWindowMs : expiryWindowMs;
      return now <= kickoff + windowMs;
    });

    console.log(`[MatchAggregator] Sync complete. Merged ${activeMatches.length} active events.`);
    // ── Provider carry-forward ──────────────────────────────────────────────
    // The cache below is written whenever ANY provider succeeded, so a single
    // provider that blips silently loses every one of its rows. DaddyLive is the
    // observed case: its schedule fetch uses a hard 6s timeout, and on a loaded
    // host it intermittently times out, which used to wipe all ~700 DaddyLive
    // entries from the cache. The catalog then showed NO DaddyLive rows for the
    // whole 4h sync interval (reproduced on production: 132 dlv rows at 01:30,
    // 0 rows at 01:34 after an automatic re-sync).
    //
    // Instead of dropping them, carry forward the provider's still-valid entries
    // from the PREVIOUS cache. Bounded deliberately:
    //   - only for a provider that returned NOTHING this round (a real outage
    //     still surfaces as an outage once the carried entries age out);
    //   - only entries still inside the normal retention window, so we never
    //     resurrect finished events;
    //   - hard capped, so a long outage cannot grow the cache without limit.
    //
    // Priority ordering before the cap (DaddyLive ~914 entries; cap was 400 so
    // live/upcoming fixtures at positions 500+ were silently dropped during outages --
    // observed in production: dlv future-dated entries went 914 --> 0):
    //   0 live now          kickoff <= now <= kickoff + 14h (matches the live window)
    //   1 upcoming          kickoff > now, sorted soonest-first
    //   2 evergreen         no parseable date (24/7 channels)
    //   3 past-in-retention kickoff already passed but still inside 24h window
    // Entries within each priority tier retain their original relative order (stable sort).
    try {
      const CARRY_FORWARD_PROVIDERS = ['daddylive'];
      const CARRY_FORWARD_MAX = Number(process.env.CARRY_FORWARD_MAX || 600);
      const nowForCarry = Date.now();
      const retentionMs = 24 * 3600 * 1000;

      const usedProvider = (provider) => finalMatches.some((m) =>
        Array.isArray(m.sources) && m.sources.some((s) => s && s.source === provider));

      let previous = [];
      try { previous = this.cacheService.getMatches() || []; } catch (_) { previous = []; }
      const presentIds = new Set(activeMatches.map((m) => m && m.id).filter(Boolean));

      for (const provider of CARRY_FORWARD_PROVIDERS) {
        // 'Provider answered' is not enough to decide health: a provider can
        // return PARTIAL data and still be broken. DaddyLive is the case that
        // proved it - it always returns 24/7 channel rows, even when the
        // schedule fetch fails, so it always looked 'healthy' while every
        // fixture was being lost (observed: channels 651, fixtures 0).
        //
        // So: prefer the provider's own declaration when it publishes one.
        // A provider whose SCHEDULE broke is treated as not-answered, and its
        // previous rows are carried forward.
        const scheduleBrokeFor = (srcName) => this.providers.some((p) =>
          p && p.sourceName === srcName && p.lastScheduleOk === false);

        if (usedProvider(provider) && !scheduleBrokeFor(provider)) continue; // provider answered fully; nothing to carry

        if (scheduleBrokeFor(provider)) {
          console.warn(`[MatchAggregator] ${provider} schedule fetch failed this sync; carrying forward its previous entries.`);
        }

        const carried = previous.filter((m) => {
          if (!m || !m.id || presentIds.has(m.id)) return false;
          if (!Array.isArray(m.sources) || !m.sources.some((s) => s && s.source === provider)) return false;
          // Date-less rows are 24/7 channels: evergreen, always keep.
          //
          // The '0'/'00' sentinel matters: _parseEventDate('0') is NOT 0, because
          // its Date.parse fallback reads the bare string "0" as the year 2000.
          // That made a 24/7 channel look ~26 years stale and get dropped. Guard
          // the sentinel explicitly, exactly as catalog.getKickoff does, and only
          // then consult the parser.
          const rawDate = m.date;
          const isEvergreen = rawDate == null || rawDate === '' || /^0+$/.test(String(rawDate).trim());
          if (isEvergreen) return true;
          const kickoff = _parseEventDate(rawDate);
          if (!kickoff) return true;
          return nowForCarry <= kickoff + retentionMs;
        }).sort((a, b) => {
          // Classify each entry into a priority bucket so that when the cap
          // bites, the entries that matter most (live -> upcoming -> evergreen ->
          // past-but-retained) survive. Without this, .slice() takes array
          // insertion order and live fixtures at positions 500+ are lost first.
          const _priority = (m) => {
            const rawDate = m.date;
            const isEvergreen = rawDate == null || rawDate === '' || /^0+$/.test(String(rawDate).trim());
            if (isEvergreen) return { bucket: 2, kickoff: 0 };
            const kickoff = _parseEventDate(rawDate);
            if (!kickoff) return { bucket: 2, kickoff: 0 };
            const LIVE_WINDOW_MS = 14 * 3600 * 1000;
            if (kickoff <= nowForCarry && nowForCarry <= kickoff + LIVE_WINDOW_MS) return { bucket: 0, kickoff };
            if (kickoff > nowForCarry) return { bucket: 1, kickoff };
            return { bucket: 3, kickoff };
          };
          const pa = _priority(a);
          const pb = _priority(b);
          if (pa.bucket !== pb.bucket) return pa.bucket - pb.bucket;
          // Within bucket 1 (upcoming) sort soonest-first so the nearest
          // fixtures survive the cap; other buckets keep insertion order (0).
          if (pa.bucket === 1) return pa.kickoff - pb.kickoff;
          return 0;
        }).slice(0, CARRY_FORWARD_MAX);

        if (carried.length > 0) {
          activeMatches.push(...carried);
          console.warn(`[MatchAggregator] ${provider} returned nothing this sync; carried forward ${carried.length} entry(ies) from the previous cache.`);
        } else {
          console.warn(`[MatchAggregator] ${provider} returned nothing this sync and no valid entries were available to carry forward.`);
        }
      }
    } catch (carryErr) {
      console.error('[MatchAggregator] Provider carry-forward failed:', carryErr.message);
    }

    if (anyProviderSucceeded) {
      // Backfill competitors derived from the title before persisting. Providers
      // that publish a head-to-head title without team1/team2 (tennis singles,
      // some cup ties) were otherwise invisible to crest enrichment, so their
      // crests were never warmed and the card had no fixture shape on first
      // render. With the names present the enrichment pass below covers them and
      // the names survive into the persisted cache.
      let backfilled = 0;
      for (const m of activeMatches) {
        if (!m || (m.team1 && m.team2)) continue;
        const derived = extractTeamsFromTitle(m.title);
        if (!derived) continue;
        if (!m.team1) m.team1 = { name: derived[0] };
        if (!m.team2) m.team2 = { name: derived[1] };
        backfilled++;
      }
      if (backfilled > 0) {
        console.log(`[MatchAggregator] Derived competitors for ${backfilled} title-only fixture(s).`);
      }

      this.cacheService.setMatches(activeMatches);

      if (this.teamLogoService) {
        // Asynchronously enrich live & upcoming matches with team badges without delaying sync
        // Previously capped at 50, so on a ~600-match catalog most fixtures never had
// their crest warmed and rendered crest-less. enrichMatch is I/O bound but runs
// concurrently and is fire-and-forget, and TeamLogoService negative-caches
// misses, so a much larger window is safe.
        // Channel/24-7 rows have no team1, so they were never warmed even though the
        // live lookup resolves most of them. Include them via their title.
        const enrichable = activeMatches.filter(m => {
          if (m.category === 'networks' || (!m.team1 && !m.team2)) return !!m.title && !m.logo;
          return (m.team1 && m.team1.name && !m.team1.logo) || !m.logo;
        }).slice(0, 600);
        // Bounded pool instead of an unbounded allSettled fan-out: 600
        // simultaneous lookups fire a burst of TLS handshakes and JSON parses
        // onto this worker right after every sync — exactly when user requests
        // are already queued. A small pool keeps the enrichment throughput
        // while capping its event-loop and socket pressure. Tune with
        // LOGO_ENRICH_CONCURRENCY if needed.
        const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.LOGO_ENRICH_CONCURRENCY || 8));
        const queue = enrichable.slice();
        const enrichWorker = async () => {
          while (queue.length) {
            const m = queue.shift();
            try { await this.teamLogoService.enrichMatch(m); } catch (_) {}
          }
        };
        Promise.all(
          Array.from({ length: Math.min(ENRICH_CONCURRENCY, enrichable.length) }, enrichWorker)
        ).catch(() => {});
      }

      return activeMatches;
    }
    return null;
  }
}

module.exports = MatchAggregator;
module.exports._internal = { _compoundify, _stripNoise, _tokenize, _teamsSimilar, _tryExtractTeams };
