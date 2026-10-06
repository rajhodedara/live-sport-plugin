/**
 * TeamLogoService.js
 *
 * Dedicated service for retrieving and caching official sports team crests,
 * league emblems, and tournament badges.
 *
 * Layers:
 * 1. Curated high-res league and tournament emblems (EPL, UCL, F1, NBA, NFL, UFC, etc.).
 * 2. Curated top sports clubs (0ms instantaneous memory resolution).
 * 3. TheSportsDB free public API search with alias resolution and entity cleaning.
 * 4. In-memory LRU + persistent JSON disk cache with negative caching.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeFetch } = require('../impitClient');

// The committed SEED of curated crests. Read-only at runtime; it is the base
// every instance starts from.
/**
 * Candidate locations for the committed crest seed.
 *
 * __dirname is not reliable here: the production bundle is built with ncc into a
 * single dist/index.js, so a path relative to __dirname resolves outside the
 * tree and the committed seed silently never loaded. Every plausible layout is
 * therefore tried, including paths relative to the working directory (PM2 starts
 * the app from the repository root).
 */
const SEED_FILES = [
  path.join(process.cwd(), 'src', 'data', 'team_logos_seed.json'),
  path.join(process.cwd(), 'data', 'team_logos_seed.json'),
  path.join(__dirname, '..', 'data', 'team_logos_seed.json'),
  path.join(__dirname, 'data', 'team_logos_seed.json'),
  path.join(__dirname, '..', 'src', 'data', 'team_logos_seed.json'),
  // Backward compatibility with the pre-split layout.
  path.join(process.cwd(), 'src', 'data', 'team_logos_cache.json'),
  path.join(__dirname, '..', 'data', 'team_logos_cache.json')
];

/**
 * Where learned crests are persisted.
 *
 * Deliberately NOT inside the tracked tree. The deploy runs
 * `git reset --hard HEAD`, which reverts tracked files to the committed state --
 * so writing learned crests into a tracked path meant every deploy discarded
 * every crest resolved since the last commit, and the site re-learned them from
 * scratch (and rendered crest-less cards until it did).
 *
 * Order: explicit env override, then an untracked `data/` directory beside the
 * running process (survives reset because it is not tracked), then temp.
 */
function resolveCacheFile() {
  if (process.env.TEAM_LOGOS_CACHE_FILE) return process.env.TEAM_LOGOS_CACHE_FILE;
  const candidates = [
    path.join(process.cwd(), 'data', 'team_logos_cache.json'),
    path.join(os.tmpdir(), 'nuvio-live-sports', 'team_logos_cache.json')
  ];
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      return candidate;
    } catch (_) { /* try the next one */ }
  }
  return candidates[candidates.length - 1];
}

const CACHE_FILE = resolveCacheFile();
const MAX_CACHE_SIZE = 5000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000; // 5 min — short enough to self-heal after transient failures

// ─── 1. Curated League & Competition Badges ─────────────────────────────────────
const LEAGUE_EMBLEMS = {
  // Football
  'premier league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  'epl': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  'english premier league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/23.png',
  'uefa champions league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2.png',
  'champions league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2.png',
  'uefa europa league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2310.png',
  'europa league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/2310.png',
  'uefa conference league': 'https://a.espncdn.com/i/leaguelogos/soccer/500/20296.png',
  'la liga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
  'laliga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/15.png',
  'serie a': 'https://a.espncdn.com/i/leaguelogos/soccer/500/12.png',
  'bundesliga': 'https://a.espncdn.com/i/leaguelogos/soccer/500/10.png',
  'ligue 1': 'https://a.espncdn.com/i/leaguelogos/soccer/500/9.png',
  'fa cup': 'https://a.espncdn.com/i/leaguelogos/soccer/500/40.png',
  'copa del rey': 'https://a.espncdn.com/i/leaguelogos/soccer/500/80.png',
  'mls': 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png',
  'major league soccer': 'https://a.espncdn.com/i/leaguelogos/soccer/500/19.png',

  // Motorsport official series emblems
  'formula 1': 'https://r2.thesportsdb.com/images/media/league/badge/g8cofl1513623681.png',
  'f1': 'https://r2.thesportsdb.com/images/media/league/badge/g8cofl1513623681.png',
  'formula e': 'https://r2.thesportsdb.com/images/media/league/badge/v91pho1674317051.png',
  'nascar': 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-NASCAR.png',
  'nascar cup series': 'https://a.espncdn.com/combiner/i?img=/redesign/assets/img/icons/ESPN-icon-NASCAR.png',
  'indycar': 'https://r2.thesportsdb.com/images/media/league/badge/m9xm9w1552216863.png',
  'indycar series': 'https://r2.thesportsdb.com/images/media/league/badge/m9xm9w1552216863.png',
  'supercars': 'https://r2.thesportsdb.com/images/media/league/badge/64f67s1770108650.png',
  'v8 supercars': 'https://r2.thesportsdb.com/images/media/league/badge/64f67s1770108650.png',
  'british gt': 'https://r2.thesportsdb.com/images/media/league/badge/w2h8gq1547547800.png',
  'btcc': 'https://r2.thesportsdb.com/images/media/league/badge/a0xreq1556444753.png',
  'world rallycross': 'https://r2.thesportsdb.com/images/media/league/badge/zzj1ut1768754454.png',
  'world rally': 'https://r2.thesportsdb.com/images/media/league/badge/zzj1ut1768754454.png',
  'wrc': 'https://r2.thesportsdb.com/images/media/league/badge/zzj1ut1768754454.png',
  'motogp': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/france/canal-plus-moto-gp-fr.png',

  // Basketball
  'nba': 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png',
  'wnba': 'https://a.espncdn.com/i/teamlogos/leagues/500/wnba.png',

  // American Football
  'nfl': 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png',
  'ncaa football': 'https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-football-college.png',
  'college football': 'https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-football-college.png',

  // Baseball
  'mlb': 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png',

  // Hockey
  'nhl': 'https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png',

  // Combat
  'ufc': 'https://r2.thesportsdb.com/images/media/team/badge/f8fdbx1725179456.png',
  'bellator': 'https://r2.thesportsdb.com/images/media/team/badge/f8fdbx1725179456.png',
  'boxing': 'https://r2.thesportsdb.com/images/media/team/badge/f8fdbx1725179456.png',

  // Tennis
  'atp': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-states/tennis-channel-us.png',
  'wta': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-states/tennis-channel-us.png',

  // Golf
  'pga tour': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'pga': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'dp world tour': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'european tour': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'lpga': 'https://a.espncdn.com/i/teamlogos/leagues/500/lpga.png',
  'liv golf': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',
  'golf': 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main/countries/united-kingdom/sky-sports-golf-uk.png',

  // Cricket leagues & tournaments
  'ipl': 'https://a.espncdn.com/i/leaguelogos/cricket/500/100.png',
  'indian premier league': 'https://a.espncdn.com/i/leaguelogos/cricket/500/100.png',
  'bbl': 'https://a.espncdn.com/i/leaguelogos/cricket/500/101.png',
  'big bash league': 'https://a.espncdn.com/i/leaguelogos/cricket/500/101.png',
  'psl': 'https://a.espncdn.com/i/leaguelogos/cricket/500/102.png',
  'pakistan super league': 'https://a.espncdn.com/i/leaguelogos/cricket/500/102.png',
  'cpl': 'https://a.espncdn.com/i/leaguelogos/cricket/500/103.png',
  'caribbean premier league': 'https://a.espncdn.com/i/leaguelogos/cricket/500/103.png',
  'sa20': 'https://a.espncdn.com/i/leaguelogos/cricket/500/104.png',
  'sri lanka premier league': 'https://a.espncdn.com/i/leaguelogos/cricket/500/105.png',
  'the hundred': 'https://a.espncdn.com/i/leaguelogos/cricket/500/106.png',
  'ilt20': 'https://a.espncdn.com/i/leaguelogos/cricket/500/107.png',
  'international league t20': 'https://a.espncdn.com/i/leaguelogos/cricket/500/107.png',
  'major league cricket': 'https://a.espncdn.com/i/leaguelogos/cricket/500/108.png',
  'mlc': 'https://a.espncdn.com/i/leaguelogos/cricket/500/108.png',
  'icc world cup': 'https://a.espncdn.com/i/leaguelogos/cricket/500/1.png',
  'icc t20 world cup': 'https://a.espncdn.com/i/leaguelogos/cricket/500/2.png',
  'icc champions trophy': 'https://a.espncdn.com/i/leaguelogos/cricket/500/3.png',
  'icc test championship': 'https://a.espncdn.com/i/leaguelogos/cricket/500/4.png',
  'asia cup': 'https://a.espncdn.com/i/leaguelogos/cricket/500/5.png',
  't20 blast': 'https://a.espncdn.com/i/leaguelogos/cricket/500/109.png',
  'vitality blast': 'https://a.espncdn.com/i/leaguelogos/cricket/500/109.png',
  'county championship': 'https://a.espncdn.com/i/leaguelogos/cricket/500/110.png',
  'ranji trophy': 'https://a.espncdn.com/i/leaguelogos/cricket/500/111.png',
  'sheffield shield': 'https://a.espncdn.com/i/leaguelogos/cricket/500/112.png'
};

// ─── 2. Curated Club Aliases ────────────────────────────────────────────────────
const TEAM_ALIASES = {
  'man utd': 'Manchester United',
  'man united': 'Manchester United',
  'man city': 'Manchester City',
  'mcfc': 'Manchester City',
  'mufc': 'Manchester United',
  'barca': 'Barcelona',
  'barça': 'Barcelona',
  'fc barcelona': 'Barcelona',
  'real madrid cf': 'Real Madrid',
  'atletico': 'Atletico Madrid',
  'atlético': 'Atletico Madrid',
  'atlético madrid': 'Atletico Madrid',
  'psg': 'Paris Saint Germain',
  'paris sg': 'Paris Saint Germain',
  'bayern': 'Bayern Munich',
  'fc bayern': 'Bayern Munich',
  'bayern munchen': 'Bayern Munich',
  'bayern münchen': 'Bayern Munich',
  'dortmund': 'Borussia Dortmund',
  'bvb': 'Borussia Dortmund',
  'inter': 'Inter Milan',
  'inter milano': 'Inter Milan',
  'ac milan': 'AC Milan',
  'juve': 'Juventus',
  'spurs': 'Tottenham Hotspur',
  'tottenham': 'Tottenham Hotspur',
  'wolves': 'Wolverhampton Wanderers',
  'brighton': 'Brighton & Hove Albion',
  'newcastle': 'Newcastle United',
  'west ham': 'West Ham United',
  'sporting cp': 'Sporting Lisbon',
  'sporting': 'Sporting Lisbon',
  'benfica': 'Benfica',
  'porto': 'Porto',
  'ajax': 'Ajax',
  'feyenoord': 'Feyenoord',
  'celtic': 'Celtic',
  'rangers': 'Rangers',
  'lakers': 'Los Angeles Lakers',
  'warriors': 'Golden State Warriors',
  'celtics': 'Boston Celtics',
  'bulls': 'Chicago Bulls',
  'heat': 'Miami Heat',
  'knicks': 'New York Knicks',
  'chiefs': 'Kansas City Chiefs',
  'eagles': 'Philadelphia Eagles',
  '49ers': 'San Francisco 49ers',
  'cowboys': 'Dallas Cowboys',
  'yankees': 'New York Yankees',
  'dodgers': 'Los Angeles Dodgers',
  'red sox': 'Boston Red Sox',
  // Arabic / Middle East clubs — providers often hyphenate or double-spell consonants
  'al-shabbab': 'Al Shabab',
  'al shabbab': 'Al Shabab',
  'al-shabab': 'Al Shabab',
  'alshabbab': 'Al Shabab',
  'al-fateh': 'Al-Fateh',
  'alfateh': 'Al-Fateh',
  'al-ahli': 'Al Ahli',
  'al ahli saudi': 'Al Ahli',
  'al-ittihad': 'Al Ittihad',
  'al ittihad': 'Al Ittihad',
  'al-hilal': 'Al Hilal',
  'al hilal sa': 'Al Hilal',
  'al-nassr': 'Al Nassr',
  'al nassr fc': 'Al Nassr',
  'al-qadsiah': 'Al Qadsiah',
  'al-taawoun': 'Al Taawoun',
  'al-feiha': 'Al Feiha',
  'al-khaleej': 'Al Khaleej',
  'al-riyadh': 'Al Riyadh',
  'al-ettifaq': 'Al Ettifaq',
  'bahrain sc': 'Bahrain SC',
  'bahrain club': 'Bahrain SC',

  // Cricket national teams & franchises — major T20 leagues (IPL, BBL, PSL, CPL, SA20, ILT20, The Hundred)
  'india': 'India',
  'team india': 'India',
  'indian cricket team': 'India',
  'aus': 'Australia',
  'australia': 'Australia',
  'aussies': 'Australia',
  'eng': 'England',
  'england': 'England',
  'pak': 'Pakistan',
  'pakistan': 'Pakistan',
  'sa': 'South Africa',
  'south africa': 'South Africa',
  'proteas': 'South Africa',
  'nz': 'New Zealand',
  'new zealand': 'New Zealand',
  'black caps': 'New Zealand',
  'wi': 'West Indies',
  'west indies': 'West Indies',
  'windies': 'West Indies',
  'sl': 'Sri Lanka',
  'sri lanka': 'Sri Lanka',
  'ban': 'Bangladesh',
  'bangladesh': 'Bangladesh',
  'tigers': 'Bangladesh',
  'afg': 'Afghanistan',
  'afghanistan': 'Afghanistan',
  'ire': 'Ireland',
  'ireland': 'Ireland',
  'zim': 'Zimbabwe',
  'zimbabwe': 'Zimbabwe',
  'ned': 'Netherlands',
  'netherlands': 'Netherlands',
  'sco': 'Scotland',
  'scotland': 'Scotland',
  'nam': 'Namibia',
  'namibia': 'Namibia',
  'oman': 'Oman',
  'png': 'Papua New Guinea',
  'papua new guinea': 'Papua New Guinea',
  'uae': 'United Arab Emirates',
  'united arab emirates': 'United Arab Emirates',
  'usa': 'United States',
  'united states': 'United States',
  'can': 'Canada',
  'canada': 'Canada',

  // IPL franchises
  'mi': 'Mumbai Indians',
  'mumbai indians': 'Mumbai Indians',
  'mumbai': 'Mumbai Indians',
  'csk': 'Chennai Super Kings',
  'chennai super kings': 'Chennai Super Kings',
  'chennai': 'Chennai Super Kings',
  'rcb': 'Royal Challengers Bangalore',
  'royal challengers bangalore': 'Royal Challengers Bangalore',
  'royal challengers': 'Royal Challengers Bangalore',
  'bangalore': 'Royal Challengers Bangalore',
  'kkr': 'Kolkata Knight Riders',
  'kolkata knight riders': 'Kolkata Knight Riders',
  'kolkata': 'Kolkata Knight Riders',
  'dc': 'Delhi Capitals',
  'delhi capitals': 'Delhi Capitals',
  'delhi': 'Delhi Capitals',
  'pbks': 'Punjab Kings',
  'punjab kings': 'Punjab Kings',
  'punjab': 'Punjab Kings',
  'kxip': 'Punjab Kings',
  'kings xi punjab': 'Punjab Kings',
  'rr': 'Rajasthan Royals',
  'rajasthan royals': 'Rajasthan Royals',
  'rajasthan': 'Rajasthan Royals',
  'srh': 'Sunrisers Hyderabad',
  'sunrisers hyderabad': 'Sunrisers Hyderabad',
  'sunrisers': 'Sunrisers Hyderabad',
  'hyderabad': 'Sunrisers Hyderabad',
  'gt': 'Gujarat Titans',
  'gujarat titans': 'Gujarat Titans',
  'gujarat': 'Gujarat Titans',
  'lsg': 'Lucknow Super Giants',
  'lucknow super giants': 'Lucknow Super Giants',
  'lucknow': 'Lucknow Super Giants',
  'ipl': 'Indian Premier League',

  // BBL teams
  'scorchers': 'Perth Scorchers',
  'perth scorchers': 'Perth Scorchers',
  'strikers': 'Adelaide Strikers',
  'adelaide strikers': 'Adelaide Strikers',
  'hurricanes': 'Hobart Hurricanes',
  'hobart hurricanes': 'Hobart Hurricanes',
  'renegades': 'Melbourne Renegades',
  'melbourne renegades': 'Melbourne Renegades',
  'stars': 'Melbourne Stars',
  'melbourne stars': 'Melbourne Stars',
  'thunder': 'Sydney Thunder',
  'sydney thunder': 'Sydney Thunder',
  'sixers': 'Sydney Sixers',
  'sydney sixers': 'Sydney Sixers',
  'heat': 'Brisbane Heat',
  'brisbane heat': 'Brisbane Heat',

  // PSL teams
  'karachi kings': 'Karachi Kings',
  'lahore qalandars': 'Lahore Qalandars',
  'islamabad united': 'Islamabad United',
  'peshawar zalmi': 'Peshawar Zalmi',
  'quetta gladiators': 'Quetta Gladiators',
  'multan sultans': 'Multan Sultans',

  // CPL teams
  'trinbago knight riders': 'Trinbago Knight Riders',
  'tkr': 'Trinbago Knight Riders',
  'guyana amazon warriors': 'Guyana Amazon Warriors',
  'st lucia kings': 'Saint Lucia Kings',
  'jamaica tallawahs': 'Jamaica Tallawahs',
  'barbados royals': 'Barbados Royals',
  'st kitts & nevis patriots': 'St Kitts & Nevis Patriots',

  // SA20 teams
  'mi cape town': 'MI Cape Town',
  'cape town': 'MI Cape Town',
  'paarl royals': 'Paarl Royals',
  'joburg super kings': 'Joburg Super Kings',
  'durban super giants': 'Durban Super Giants',
  'pretoria capitals': 'Pretoria Capitals',
  'sunrisers eastern cape': 'Sunrisers Eastern Cape',

  // ILT20 teams
  'dubai capitals': 'Dubai Capitals',
  'abu dhabi knight riders': 'Abu Dhabi Knight Riders',
  'sharjah warriors': 'Sharjah Warriors',
  'desert viper': 'Desert Vipers',
  'desert vipers': 'Desert Vipers',
  'gulf giants': 'Gulf Giants',

  // The Hundred teams
  'oval invincibles': 'Oval Invincibles',
  'southern brave': 'Southern Brave',
  'manchester originals': 'Manchester Originals',
  'northern superchargers': 'Northern Superchargers',
  'birmingham phoenix': 'Birmingham Phoenix',
  'trent rockets': 'Trent Rockets',
  'welsh fire': 'Welsh Fire',
  'london spirit': 'London Spirit',

  // European Football, Basketball, Hockey, Handball & Rugby aliases
  'sporting braga': 'Braga',
  'sc braga': 'Braga',
  'sluc nancy': 'SLUC Nancy',
  'nancy': 'SLUC Nancy',
  'paris': 'Paris Basketball',
  'vfl gummersbach': 'VfL Gummersbach',
  'gummersbach': 'VfL Gummersbach',
  'bergischer hc': 'Bergischer HC',
  'bergischer': 'Bergischer HC',
  'telekom baskets bonn': 'Bonn',
  'syntainics mbc': 'Syntainics MBC',
  'gladiators trier': 'Trier',
  'science city jena': 'Jena',
  'kolner haie': 'Kolner',
  'ewe baskets oldenburg': 'Oldenburg',
  'hamburg towers': 'Hamburg',
  'as roma': 'Roma',
  'us sassuolo': 'Sassuolo'
};

// ─── 3. Instant Curated Top Badges ──────────────────────────────────────────────
const CURATED_BADGES = {
  // Premier League & Major European Clubs
  'arsenal': 'https://r2.thesportsdb.com/images/media/team/badge/uyhbfe1612467038.png',
  'aston villa': 'https://r2.thesportsdb.com/images/media/team/badge/uwzw561787679026.png',
  'bournemouth': 'https://r2.thesportsdb.com/images/media/team/badge/y08nak1534071116.png',
  'afc bournemouth': 'https://r2.thesportsdb.com/images/media/team/badge/y08nak1534071116.png',
  'brentford': 'https://r2.thesportsdb.com/images/media/team/badge/k84q5f1618386125.png',
  'brighton': 'https://r2.thesportsdb.com/images/media/team/badge/7aoml31716960458.png',
  'brighton & hove albion': 'https://r2.thesportsdb.com/images/media/team/badge/7aoml31716960458.png',
  'chelsea': 'https://r2.thesportsdb.com/images/media/team/badge/yvwvtu1448813215.png',
  'crystal palace': 'https://r2.thesportsdb.com/images/media/team/badge/8z346p1716960555.png',
  'everton': 'https://r2.thesportsdb.com/images/media/team/badge/eqayrf1523184794.png',
  'fulham': 'https://r2.thesportsdb.com/images/media/team/badge/xwwvyt1448811086.png',
  'ipswich': 'https://r2.thesportsdb.com/images/media/team/badge/8z906k1716960578.png',
  'ipswich town': 'https://r2.thesportsdb.com/images/media/team/badge/8z906k1716960578.png',
  'leicester city': 'https://r2.thesportsdb.com/images/media/team/badge/1w7u6x1561882650.png',
  'liverpool': 'https://r2.thesportsdb.com/images/media/team/badge/kfaher1737969724.png',
  'manchester city': 'https://r2.thesportsdb.com/images/media/team/badge/vwpvry1467462651.png',
  'manchester united': 'https://r2.thesportsdb.com/images/media/team/badge/xzqdr11517660252.png',
  'newcastle': 'https://r2.thesportsdb.com/images/media/team/badge/65yvdq1716960481.png',
  'newcastle united': 'https://r2.thesportsdb.com/images/media/team/badge/65yvdq1716960481.png',
  'nottingham forest': 'https://r2.thesportsdb.com/images/media/team/badge/8514i01654005832.png',
  'southampton': 'https://r2.thesportsdb.com/images/media/team/badge/7bvxk71716960599.png',
  'tottenham hotspur': 'https://r2.thesportsdb.com/images/media/team/badge/dfyfhl1604094109.png',
  'west ham': 'https://r2.thesportsdb.com/images/media/team/badge/hfum4l1599931799.png',
  'west ham united': 'https://r2.thesportsdb.com/images/media/team/badge/hfum4l1599931799.png',
  'wolves': 'https://r2.thesportsdb.com/images/media/team/badge/2e87901716960506.png',
  'wolverhampton wanderers': 'https://r2.thesportsdb.com/images/media/team/badge/2e87901716960506.png',

  // Spain & Europe
  'barcelona': 'https://r2.thesportsdb.com/images/media/team/badge/wq9sir1639406443.png',
  'real madrid': 'https://r2.thesportsdb.com/images/media/team/badge/vwvwrw1473502969.png',
  'atletico madrid': 'https://r2.thesportsdb.com/images/media/team/badge/0ulh3q1719984315.png',
  'real valladolid': 'https://r2.thesportsdb.com/images/media/team/badge/bnhu8b1719983736.png',
  'valladolid': 'https://r2.thesportsdb.com/images/media/team/badge/bnhu8b1719983736.png',
  'cordoba': 'https://r2.thesportsdb.com/images/media/team/badge/ttyyvy1473503827.png',
  'córdoba': 'https://r2.thesportsdb.com/images/media/team/badge/ttyyvy1473503827.png',
  'cordoba cf': 'https://r2.thesportsdb.com/images/media/team/badge/ttyyvy1473503827.png',
  'bayern munich': 'https://r2.thesportsdb.com/images/media/team/badge/01ogkh1716960412.png',
  'borussia dortmund': 'https://r2.thesportsdb.com/images/media/team/badge/tqo8ge1716960353.png',
  'paris saint germain': 'https://r2.thesportsdb.com/images/media/team/badge/rwqrrq1473504808.png',
  'juventus': 'https://r2.thesportsdb.com/images/media/team/badge/uxf0gr1742983727.png',
  'inter milan': 'https://r2.thesportsdb.com/images/media/team/badge/ryhu6d1617113103.png',
  'ac milan': 'https://r2.thesportsdb.com/images/media/team/badge/wvspur1448806617.png',
  'los angeles lakers': 'https://r2.thesportsdb.com/images/media/team/badge/d8uoxw1714254511.png',
  'golden state warriors': 'https://r2.thesportsdb.com/images/media/team/badge/xokycb1778197905.png',
  'boston celtics': 'https://r2.thesportsdb.com/images/media/team/badge/4j85bn1667936589.png',
  'dubai': 'https://r2.thesportsdb.com/images/media/team/badge/f95loc1721480695.png',
  'dubai basketball': 'https://r2.thesportsdb.com/images/media/team/badge/f95loc1721480695.png',
  'vienna basket': 'https://r2.thesportsdb.com/images/media/team/badge/okeyil1784571631.png',
  'vienna': 'https://r2.thesportsdb.com/images/media/team/badge/okeyil1784571631.png',
  'bc vienna': 'https://r2.thesportsdb.com/images/media/team/badge/okeyil1784571631.png',
  'kansas city chiefs': 'https://r2.thesportsdb.com/images/media/team/badge/n58gp51784720929.png',
  'ferrari': 'https://r2.thesportsdb.com/images/media/team/badge/fk5myv1561490584.png',
  'red bull racing': 'https://r2.thesportsdb.com/images/media/team/badge/si5qxc1733228232.png',
  'mercedes amg': 'https://r2.thesportsdb.com/images/media/team/badge/96kai71734120813.png',
  'mclaren': 'https://r2.thesportsdb.com/images/media/team/badge/5k3mwe1749225165.png',
  'radomlje': 'https://r2.thesportsdb.com/images/media/team/badge/gh0sjd1625755749.png',
  'bravo': 'https://r2.thesportsdb.com/images/media/team/badge/szjnx81579812986.png',
  'sporting braga': 'https://r2.thesportsdb.com/images/media/team/badge/skbiwo1785775946.png',
  'braga': 'https://r2.thesportsdb.com/images/media/team/badge/skbiwo1785775946.png',
  'sc braga': 'https://r2.thesportsdb.com/images/media/team/badge/skbiwo1785775946.png',
  'sporting cp': 'https://r2.thesportsdb.com/images/media/team/badge/5hiuk71783137875.png',
  'sassuolo': 'https://r2.thesportsdb.com/images/media/team/badge/xystvp1448806138.png',
  'roma': 'https://r2.thesportsdb.com/images/media/team/badge/jwro2s1760820674.png',
  'as roma': 'https://r2.thesportsdb.com/images/media/team/badge/jwro2s1760820674.png',
  'leicester tigers': 'https://r2.thesportsdb.com/images/media/team/badge/d59nhl1523219441.png',
  'saracens': 'https://r2.thesportsdb.com/images/media/team/badge/ek19321758786974.png',
  'angers w': 'https://r2.thesportsdb.com/images/media/team/badge/qq87qd1757667500.png',
  'landes w': 'https://r2.thesportsdb.com/images/media/team/badge/b9kc4z1757703518.png',
  'hannover-burgdorf': 'https://r2.thesportsdb.com/images/media/team/badge/t6c1vt1567620859.png',
  'hannover burgdorf': 'https://r2.thesportsdb.com/images/media/team/badge/t6c1vt1567620859.png',
  'goppingen': 'https://r2.thesportsdb.com/images/media/team/badge/gcp6ko1643117660.png',
  'bonn': 'https://r2.thesportsdb.com/images/media/team/badge/fva1jj1726927533.png',
  'syntainics mbc': 'https://r2.thesportsdb.com/images/media/team/badge/y4h9ox1714562760.png',
  'trier': 'https://r2.thesportsdb.com/images/media/team/badge/b1vbm11593871848.png',
  'jena': 'https://r2.thesportsdb.com/images/media/team/badge/r69p651579106388.png',
  'sluc nancy': 'https://r2.thesportsdb.com/images/media/team/badge/6zbuwh1666897360.png',
  'nancy': 'https://r2.thesportsdb.com/images/media/team/badge/6zbuwh1666897360.png',
  'paris basketball': 'https://r2.thesportsdb.com/images/media/team/badge/9q0d6x1726681476.png',
  'vfl gummersbach': 'https://r2.thesportsdb.com/images/media/team/badge/o8ikpz1662032900.png',
  'gummersbach': 'https://r2.thesportsdb.com/images/media/team/badge/o8ikpz1662032900.png',
  'bergischer hc': 'https://r2.thesportsdb.com/images/media/team/badge/20sguw1567030747.png',
  'bergischer': 'https://r2.thesportsdb.com/images/media/team/badge/20sguw1567030747.png',
  'leksands': 'https://r2.thesportsdb.com/images/media/team/badge/ruij751571478402.png',
  'almtuna': 'https://r2.thesportsdb.com/images/media/team/badge/h2i61r1700826162.png',
  'aik': 'https://r2.thesportsdb.com/images/media/team/badge/rwsrxq1420769503.png',
  'mora': 'https://r2.thesportsdb.com/images/media/team/badge/9o7dan1735179353.png',
  'augsburger panther': 'https://r2.thesportsdb.com/images/media/team/badge/gnxeom1637465072.png',
  'kolner': 'https://r2.thesportsdb.com/images/media/team/badge/wnlfnz1637465482.png',
  'kolner haie': 'https://r2.thesportsdb.com/images/media/team/badge/wnlfnz1637465482.png',
  'nurnberg ice tigers': 'https://r2.thesportsdb.com/images/media/team/badge/ypza921637465542.png',
  'straubing tigers': 'https://r2.thesportsdb.com/images/media/team/badge/a9dpzy1647637978.png',
  'chemnitz': 'https://r2.thesportsdb.com/images/media/team/badge/cxc1gc1579106325.png',
  'phoenix hagen': 'https://r2.thesportsdb.com/images/media/team/badge/o2zxvc1573655706.png',
  'oldenburg': 'https://r2.thesportsdb.com/images/media/team/badge/91nb4u1580151655.png',
  'hamburg': 'https://r2.thesportsdb.com/images/media/team/badge/tvtppt1473453296.png',

  // Cricket national teams (Official ESPN 500x500 badges)
  'england': 'https://a.espncdn.com/i/teamlogos/cricket/500/1.png',
  'australia': 'https://a.espncdn.com/i/teamlogos/cricket/500/2.png',
  'south africa': 'https://a.espncdn.com/i/teamlogos/cricket/500/3.png',
  'west indies': 'https://a.espncdn.com/i/teamlogos/cricket/500/4.png',
  'new zealand': 'https://a.espncdn.com/i/teamlogos/cricket/500/5.png',
  'india': 'https://a.espncdn.com/i/teamlogos/cricket/500/6.png',
  'pakistan': 'https://a.espncdn.com/i/teamlogos/cricket/500/7.png',
  'sri lanka': 'https://a.espncdn.com/i/teamlogos/cricket/500/8.png',
  'zimbabwe': 'https://a.espncdn.com/i/teamlogos/cricket/500/9.png',
  'united states': 'https://a.espncdn.com/i/teamlogos/cricket/500/11.png',
  'usa': 'https://a.espncdn.com/i/teamlogos/cricket/500/11.png',
  'netherlands': 'https://a.espncdn.com/i/teamlogos/cricket/500/15.png',
  'canada': 'https://a.espncdn.com/i/teamlogos/cricket/500/17.png',
  'papua new guinea': 'https://a.espncdn.com/i/teamlogos/cricket/500/20.png',
  'bangladesh': 'https://a.espncdn.com/i/teamlogos/cricket/500/25.png',
  'united arab emirates': 'https://a.espncdn.com/i/teamlogos/cricket/500/27.png',
  'uae': 'https://a.espncdn.com/i/teamlogos/cricket/500/27.png',
  'namibia': 'https://a.espncdn.com/i/teamlogos/cricket/500/28.png',
  'ireland': 'https://a.espncdn.com/i/teamlogos/cricket/500/29.png',
  'scotland': 'https://a.espncdn.com/i/teamlogos/cricket/500/30.png',
  'afghanistan': 'https://a.espncdn.com/i/teamlogos/cricket/500/40.png',

  // Major T20 Cricket Franchises (IPL, BBL, PSL)
  'mumbai indians': 'https://r2.thesportsdb.com/images/media/team/badge/l40j8p1487678631.png',
  'chennai super kings': 'https://r2.thesportsdb.com/images/media/team/badge/okceh51487601098.png',
  'royal challengers bangalore': 'https://r2.thesportsdb.com/images/media/team/badge/kynj5v1588331757.png',
  'kolkata knight riders': 'https://r2.thesportsdb.com/images/media/team/badge/ows99r1487678296.png',
  'delhi capitals': 'https://r2.thesportsdb.com/images/media/team/badge/dg4g0z1587334054.png',
  'rajasthan royals': 'https://r2.thesportsdb.com/images/media/team/badge/lehnfw1487601864.png',
  'punjab kings': 'https://r2.thesportsdb.com/images/media/team/badge/r1tcie1630697821.png',
  'sunrisers hyderabad': 'https://r2.thesportsdb.com/images/media/team/badge/sc7m161487419327.png',
  'gujarat titans': 'https://r2.thesportsdb.com/images/media/team/badge/6qw4r71654174508.png',
  'lucknow super giants': 'https://r2.thesportsdb.com/images/media/team/badge/4tzmfa1647445839.png',
  'perth scorchers': 'https://r2.thesportsdb.com/images/media/team/badge/ithlp51546681732.png',
  'sydney sixers': 'https://r2.thesportsdb.com/images/media/team/badge/jtkm601492607206.png',
  'melbourne stars': 'https://r2.thesportsdb.com/images/media/team/badge/l0t7v31715269757.png',
  'lahore qalandars': 'https://r2.thesportsdb.com/images/media/team/badge/hvrtrg1709123519.png',
  'karachi kings': 'https://r2.thesportsdb.com/images/media/team/badge/tfuvu11709123541.png',
  'islamabad united': 'https://r2.thesportsdb.com/images/media/team/badge/5bi3eb1709123559.png'
};

class TeamLogoService {
  constructor() {
    this.cache = new Map(); // key -> { url, expiresAt }
    this.inFlight = new Map(); // key -> Promise<string|null>
    // Optional callback fired (debounced) whenever a NEW team badge is found,
    // so generation-keyed caches (catalog page memo) can rebuild pages that
    // were built before this crest was available.
    this.onChange = null;
    this._lastLogoNotify = 0;
    this._logoDirty = false;
    this._logoNotifyTimer = null;
    this._loadDiskCache();
  }

  // Fire onChange at most every 20s (leading edge + one trailing fire), so a
  // post-sync burst of badge lookups causes a couple of rebuilds instead of
  // one per lookup.
  _notifyLogoChanged() {
    if (typeof this.onChange !== 'function') return;
    this._logoDirty = true;
    const now = Date.now();
    if (now - this._lastLogoNotify >= 20000) {
      this._lastLogoNotify = now;
      this._logoDirty = false;
      try { this.onChange(); } catch (_) {}
    } else if (!this._logoNotifyTimer) {
      this._logoNotifyTimer = setTimeout(() => {
        this._logoNotifyTimer = null;
        if (this._logoDirty) {
          this._lastLogoNotify = Date.now();
          this._logoDirty = false;
          try { this.onChange(); } catch (_) {}
        }
      }, 20000);
      if (this._logoNotifyTimer.unref) this._logoNotifyTimer.unref();
    }
  }

  _loadDiskCache() {
    const ttl = 30 * 24 * 3600 * 1000;
    const ingest = (filePath) => {
      try {
        if (!filePath || !fs.existsSync(filePath)) return 0;
        const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!json || typeof json !== 'object') return 0;
        let n = 0;
        for (const [k, v] of Object.entries(json)) {
          if (typeof v === 'string' && v) { this.cache.set(k, { url: v, expiresAt: Date.now() + ttl }); n++; }
        }
        return n;
      } catch (_) { return 0; }
    };
    // Seed first so the runtime cache (loaded second) can override it.
    for (const seedFile of SEED_FILES) ingest(seedFile);
    ingest(CACHE_FILE);
  }

  _saveDiskCache() {
    try {
      const obj = {};
      for (const [k, entry] of this.cache.entries()) {
        if (entry && entry.url) obj[k] = entry.url;
      }
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tempPath = `${CACHE_FILE}.tmp.${process.pid}`;
      fs.writeFileSync(tempPath, JSON.stringify(obj, null, 2), 'utf-8');
      fs.renameSync(tempPath, CACHE_FILE);
    } catch (_) {}
  }

  _cleanName(name) {
    if (!name || typeof name !== 'string') return '';
    return name
      // Strip all emojis, flags, regional indicator symbols, tag characters, black flag
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{1F3F4}]/gu, '')
      // Fold diacritics / accents (e.g. Córdoba -> Cordoba, Atlético -> Atletico, München -> Munchen)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // Strip club type affixes (keep 'united' and 'city' so Manchester United/City aren't mangled!)
      .replace(/\b(fc|cf|sc|cd|ca|afc|fk|sk|bk|rsc|vfb|tsv|basket|baskets|bc)\b/gi, ' ')
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _normalizeKey(name) {
    if (!name) return '';
    return String(name)
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{1F3F4}]/gu, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Synchronous check for known or cached team badge.
   */
  getCachedLogo(teamName) {
    if (!teamName) return null;
    const rawLower = String(teamName).toLowerCase().trim();
    // Strip emojis (including Unicode flags, tag sequences, symbols) while preserving words & spaces
    const cleanLower = rawLower
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}\u{1F3F4}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const key = this._normalizeKey(teamName);
    const cleanKey = cleanLower ? this._normalizeKey(cleanLower) : key;

    // 1. Direct Curated Badges (raw, emoji-stripped, or diacritic-folded)
    if (CURATED_BADGES[rawLower]) return CURATED_BADGES[rawLower];
    if (cleanLower && CURATED_BADGES[cleanLower]) return CURATED_BADGES[cleanLower];
    const foldedLower = cleanLower ? cleanLower.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : null;
    if (foldedLower && CURATED_BADGES[foldedLower]) return CURATED_BADGES[foldedLower];

    // 2. Alias mapping (try raw, emoji-stripped, folded, and normalized key)
    const aliasTarget = TEAM_ALIASES[rawLower] || (cleanLower && TEAM_ALIASES[cleanLower]) || (foldedLower && TEAM_ALIASES[foldedLower]) || TEAM_ALIASES[key] || TEAM_ALIASES[cleanKey];
    if (aliasTarget) {
      const aliasLower = aliasTarget.toLowerCase();
      const aliasFolded = aliasLower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (CURATED_BADGES[aliasLower]) return CURATED_BADGES[aliasLower];
      if (CURATED_BADGES[aliasFolded]) return CURATED_BADGES[aliasFolded];
      const aliasKey = this._normalizeKey(aliasTarget);
      const aliasCached = this.cache.get(aliasKey);
      if (aliasCached && aliasCached.url && aliasCached.expiresAt > Date.now()) {
        return aliasCached.url;
      }
    }

    // 3. Memory cache
    const cached = this.cache.get(key) || (cleanKey !== key ? this.cache.get(cleanKey) : null);
    if (cached) {
      if (cached.expiresAt > Date.now()) return cached.url || null;
      this.cache.delete(key);
      if (cleanKey !== key) this.cache.delete(cleanKey);
    }

    // 4. Pattern-based affix stripping (strip generic suffixes: w, women, lfc, u20, and club affixes: fc, sc, etc.)
    const lookupKey = (k) => {
      if (!k) return null;
      if (CURATED_BADGES[k]) return CURATED_BADGES[k];
      const c = this.cache.get(k);
      return (c && c.url && c.expiresAt > Date.now()) ? c.url : null;
    };

    // A. Strip trailing gender/age qualifiers: women, lfc, u20, u21, u19, w
    const baseKey = cleanKey.replace(/(women|lfc|u20|u21|u19|u23|w)$/, '');
    if (baseKey && baseKey !== cleanKey) {
      const match = lookupKey(baseKey);
      if (match) return match;
    }

    // B. Strip club prefixes / suffixes: fc, sc, cf, ac, bk, hc, cd
    const strippedClub = cleanKey
      .replace(/^(fc|sc|cf|ac|bk|hc|cd)/, '')
      .replace(/(fc|sc|cf|ac|bk|hc|cd)$/, '');
    if (strippedClub && strippedClub !== cleanKey) {
      const match = lookupKey(strippedClub);
      if (match) return match;
    }

    // C. Clean name fallback
    const cleanedName = this._cleanName(teamName);
    const cleanedKey = this._normalizeKey(cleanedName);
    if (cleanedKey && cleanedKey !== key && cleanedKey !== cleanKey) {
      const match = lookupKey(cleanedKey);
      if (match) return match;
    }

    return null;
  }

  /**
   * Resolves a league or competition emblem from league name or event title.
   */
  getLeagueLogo(leagueName, eventTitle = '', category = '') {
    const targets = [
      String(leagueName || '').toLowerCase().trim(),
      String(eventTitle || '').toLowerCase().trim()
    ];

    for (const target of targets) {
      if (!target) continue;
      for (const [key, emblemUrl] of Object.entries(LEAGUE_EMBLEMS)) {
        if (target === key || target.includes(key)) {
          return emblemUrl;
        }
      }
    }

    // Category fallbacks
    const cat = String(category || '').toLowerCase();
    if (cat === 'motorsport' || cat === 'f1') {
      return LEAGUE_EMBLEMS['formula 1'];
    }
    if (cat === 'basketball' || cat === 'nba') {
      return LEAGUE_EMBLEMS['nba'];
    }
    if (cat === 'american_football' || cat === 'nfl') {
      return LEAGUE_EMBLEMS['nfl'];
    }
    if (cat === 'baseball' || cat === 'mlb') {
      return LEAGUE_EMBLEMS['mlb'];
    }
    if (cat === 'hockey' || cat === 'nhl') {
      return LEAGUE_EMBLEMS['nhl'];
    }
    if (cat === 'mma' || cat === 'fighting') {
      return LEAGUE_EMBLEMS['ufc'];
    }
    if (cat === 'golf') {
      return LEAGUE_EMBLEMS['golf'];
    }
    if (cat === 'cricket') {
      return LEAGUE_EMBLEMS['ipl'];
    }

    return null;
  }

  /**
   * Asynchronously searches for a team badge using TheSportsDB.
   */
  async findTeamLogo(teamName) {
    if (!teamName || typeof teamName !== 'string') return null;

    const rawLower = String(teamName).toLowerCase().trim();
    const key = this._normalizeKey(teamName);

    // Instant cached lookup
    const cached = this.getCachedLogo(teamName);
    if (cached) return cached;

    // Check negative cache
    const negEntry = this.cache.get(key);
    if (negEntry && !negEntry.url && negEntry.expiresAt > Date.now()) {
      return null;
    }

    // De-duplicate in-flight requests
    if (this.inFlight.has(key)) {
      return await this.inFlight.get(key);
    }

    const fetchPromise = (async () => {
      try {
        const queryName = TEAM_ALIASES[rawLower] || teamName;
        const cleanQuery = this._cleanName(queryName) || queryName;

        const url = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(cleanQuery)}`;
        const res = await safeFetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': 'application/json'
          },
          signal: AbortSignal.timeout(6000)
        });

        if (res && res.ok) {
          let data = null;
          try {
            data = typeof res.json === 'function' ? await res.json() : JSON.parse(res.text);
          } catch (_) { data = null; }

          if (data && Array.isArray(data.teams) && data.teams.length > 0) {
            const queryLower = cleanQuery.toLowerCase();
            const bestTeam = data.teams.find(tm => {
              const strTeam = (tm.strTeam || '').toLowerCase();
              const strAlt = (tm.strAlternate || '').toLowerCase();
              return strTeam === queryLower || strAlt.includes(queryLower) || strTeam.includes(queryLower);
            }) || data.teams[0];

            if (bestTeam && bestTeam.strBadge) {
              const badgeUrl = bestTeam.strBadge;
              const prev = this.cache.get(key);
              this.cache.set(key, { url: badgeUrl, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 });
              if (this.cache.size % 20 === 0) this._saveDiskCache();
              // A crest that wasn't there before changes how match cards render —
              // tell generation-keyed caches to rebuild.
              if (!prev || prev.url !== badgeUrl) this._notifyLogoChanged();
              return badgeUrl;
            }
          }

          // Only negative cache if we successfully received a 200 OK from TheSportsDB indicating no teams found
          if (data) {
            this.cache.set(key, { url: null, expiresAt: Date.now() + NEGATIVE_TTL_MS });
          }
          return null;
        }

        // On rate-limits (429) or server errors, do not write a negative cache entry
        return null;
      } catch (_) {
        return null;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, fetchPromise);
    return await fetchPromise;
  }

  /**
   * Enriches a match entity with team and event badges.
   */
  async enrichMatch(match) {
    if (!match) return match;

    // 1. Team 1 badge
    if (match.team1 && match.team1.name && !match.team1.logo) {
      const b1 = await this.findTeamLogo(match.team1.name);
      if (b1) match.team1.logo = b1;
    }

    // 2. Team 2 badge
    if (match.team2 && match.team2.name && !match.team2.logo) {
      const b2 = await this.findTeamLogo(match.team2.name);
      if (b2) match.team2.logo = b2;
    }

    // 3. Match primary logo fallback
    if (!match.logo) {
      if (match.team1 && match.team1.logo) {
        match.logo = match.team1.logo;
      } else {
        const leagueLogo = this.getLeagueLogo(match.league, match.title, match.category);
        if (leagueLogo) match.logo = leagueLogo;
      }
    }

    return match;
  }
}

module.exports = TeamLogoService;
