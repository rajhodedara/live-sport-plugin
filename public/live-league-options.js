(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var exports = factory();
    root.LIVE_LEAGUE_GROUPS = exports.LIVE_LEAGUE_GROUPS;
    root.normalizeLeagueName = exports.normalizeLeagueName;
    root.ALL_CURATED_LEAGUE_IDS = exports.ALL_CURATED_LEAGUE_IDS;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  function normalizeLeagueName(value) {
    if (!value || typeof value !== 'string') return '';
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  var LIVE_LEAGUE_GROUPS = [
    {
      label: 'Soccer',
      options: [
        { id: 'mls', label: 'MLS', categories: ['football'], aliases: ['Major League Soccer', 'USA MLS'] },
        { id: 'nwsl', label: 'NWSL', categories: ['football'], aliases: ['National Womens Soccer League', "National Women's Soccer League"] },
        { id: 'tanzanian-premier-league', label: 'Tanzanian Premier League', categories: ['football'], aliases: ['Ligi Kuu Bara', 'NBC Premier League', 'Tanzania Premier League'] },
        { id: 'epl', label: 'Premier League', categories: ['football'], aliases: ['EPL', 'English Premier League', 'Premier League England'] },
        { id: 'laliga-2', label: 'LaLiga 2', categories: ['football'], aliases: ['La Liga 2', 'Segunda Division', 'LaLiga Hypermotion', 'La Liga Hypermotion'] },
        { id: 'la-liga', label: 'La Liga', categories: ['football'], aliases: ['LaLiga', 'Primera Division', 'La Liga Spain', 'Spanish La Liga'] },
        { id: 'serie-a', label: 'Serie A', categories: ['football'], aliases: ['Serie A Italy', 'Italian Serie A', 'Lega Serie A'] },
        { id: '2-bundesliga', label: '2. Bundesliga', categories: ['football'], aliases: ['2 Bundesliga', 'Zweite Bundesliga'] },
        { id: 'bundesliga', label: 'Bundesliga', categories: ['football'], aliases: ['1. Bundesliga', 'German Bundesliga', 'Bundesliga Germany'] },
        { id: 'ligue-1', label: 'Ligue 1', categories: ['football'], aliases: ['French Ligue 1', "Ligue 1 McDonald's", 'Ligue 1 Uber Eats', 'Ligue 1 France'] },
        { id: 'caf-champions-league', label: 'CAF Champions League', categories: ['football'], aliases: ['CAF CL', 'TotalEnergies CAF Champions League'] },
        { id: 'womens-champions-league', label: "Women's Champions League", categories: ['football'], aliases: ['UWCL', "UEFA Women's Champions League", 'UEFA Womens Champions League'] },
        { id: 'ucl', label: 'Champions League', categories: ['football'], aliases: ['UCL', 'UEFA Champions League'] },
        { id: 'europa-league', label: 'Europa League', categories: ['football'], aliases: ['UEL', 'UEFA Europa League'] },
        { id: 'liga-mx', label: 'Liga MX', categories: ['football'], aliases: ['Mexican Primera Division', 'Liga BBVA MX'] },
        { id: 'brasileirao', label: 'Brasileirão', categories: ['football'], aliases: ['Brasileirao', 'Campeonato Brasileiro', 'Brasileirao Serie A', 'Brasileirão Série A'] },
        { id: 'argentine-primera', label: 'Argentine Primera', categories: ['football'], aliases: ['Argentine Primera Division', 'Liga Profesional de Futbol', 'Primera Division Argentina'] },
        { id: 'saudi-pro-league', label: 'Saudi Pro League', categories: ['football'], aliases: ['SPL', 'Roshn Saudi League', 'Saudi Professional League'] }
      ]
    },
    {
      label: 'American Football',
      options: [
        { id: 'nfl', label: 'NFL', categories: ['american_football'], aliases: ['National Football League', 'NFL Football'] },
        { id: 'college-football', label: 'College Football', categories: ['american_football', 'college'], aliases: ['NCAA Football', 'NCAAF', 'CFB', 'College Football'] },
        { id: 'ufl', label: 'UFL', categories: ['american_football'], aliases: ['United Football League'] },
        { id: 'cfl', label: 'CFL', categories: ['american_football'], aliases: ['Canadian Football League'] }
      ]
    },
    {
      label: 'Basketball',
      options: [
        { id: 'nba', label: 'NBA', categories: ['basketball'], aliases: ['National Basketball Association', 'NBA Playoffs', 'NBA Finals'] },
        { id: 'wnba', label: 'WNBA', categories: ['basketball'], aliases: ["Women's National Basketball Association", 'Womens National Basketball Association'] },
        { id: 'college-basketball', label: 'College Basketball', categories: ['basketball', 'college'], aliases: ['NCAA Basketball', 'NCAAB', 'College Basketball', "Men's College Basketball", "Women's College Basketball"] },
        { id: 'euroleague', label: 'EuroLeague', categories: ['basketball'], aliases: ['Euroleague Basketball', 'Turkish Airlines EuroLeague'] },
        { id: 'nbl', label: 'NBL', categories: ['basketball'], aliases: ['National Basketball League'] }
      ]
    },
    {
      label: 'Baseball',
      options: [
        { id: 'mlb', label: 'MLB', categories: ['baseball'], aliases: ['Major League Baseball', 'MLB Baseball'] },
        { id: 'college-baseball', label: 'College Baseball', categories: ['baseball', 'college'], aliases: ['NCAA Baseball', 'College Baseball'] }
      ]
    },
    {
      label: 'Hockey',
      options: [
        { id: 'nhl', label: 'NHL', categories: ['hockey'], aliases: ['National Hockey League', 'NHL Hockey'] },
        { id: 'college-hockey', label: 'College Hockey', categories: ['hockey', 'college'], aliases: ['NCAA Hockey', 'College Hockey'] }
      ]
    },
    {
      label: 'Tennis',
      options: [
        { id: 'atp', label: 'ATP', categories: ['tennis'], aliases: ['ATP Tour', 'ATP Tennis', 'Association of Tennis Professionals'] },
        { id: 'wta', label: 'WTA', categories: ['tennis'], aliases: ['WTA Tour', 'WTA Tennis', "Women's Tennis Association"] },
        { id: 'grand-slams', label: 'Grand Slams', categories: ['tennis'], aliases: ['Grand Slam', 'Australian Open', 'Roland Garros', 'French Open', 'Wimbledon', 'US Open'] }
      ]
    },
    {
      label: 'Cricket',
      options: [
        { id: 'ipl', label: 'IPL', categories: ['cricket'], aliases: ['Indian Premier League', 'Tata IPL'] },
        { id: 't20-world-cup', label: 'T20 World Cup', categories: ['cricket'], aliases: ["ICC Men's T20 World Cup", 'ICC T20 World Cup', 'T20 WC'] },
        { id: 'big-bash', label: 'Big Bash', categories: ['cricket'], aliases: ['BBL', 'Big Bash League', 'KFC Big Bash League'] },
        { id: 'psl', label: 'PSL', categories: ['cricket'], aliases: ['Pakistan Super League', 'HBL PSL'] }
      ]
    },
    {
      label: 'Motorsport',
      options: [
        { id: 'formula-1', label: 'Formula 1', categories: ['motorsport'], aliases: ['F1', 'Formula One', 'FIA Formula One World Championship'] },
        { id: 'motogp', label: 'MotoGP', categories: ['motorsport'], aliases: ['Moto GP', 'FIM MotoGP World Championship'] },
        { id: 'nascar', label: 'NASCAR', categories: ['motorsport'], aliases: ['NASCAR Cup Series', 'NASCAR Xfinity Series'] },
        { id: 'indycar', label: 'IndyCar', categories: ['motorsport'], aliases: ['NTT IndyCar Series', 'Indy Car'] }
      ]
    },
    {
      label: 'Rugby',
      options: [
        { id: 'six-nations', label: 'Six Nations', categories: ['rugby'], aliases: ['Guinness Six Nations', '6 Nations'] },
        { id: 'super-rugby', label: 'Super Rugby', categories: ['rugby'], aliases: ['Super Rugby Pacific'] },
        { id: 'nrl', label: 'NRL', categories: ['rugby'], aliases: ['National Rugby League', 'Telstra Premiership'] }
      ]
    },
    {
      label: 'Combat Sports',
      options: [
        { id: 'ufc', label: 'UFC', categories: ['mma'], aliases: ['Ultimate Fighting Championship'] },
        { id: 'boxing', label: 'Boxing', categories: ['mma'], aliases: ['Professional Boxing', 'World Boxing'] },
        { id: 'pfl', label: 'PFL', categories: ['mma'], aliases: ['Professional Fighters League'] }
      ]
    },
    {
      label: 'Golf',
      options: [
        { id: 'pga-tour', label: 'PGA Tour', categories: ['golf'], aliases: ['PGA', 'PGA TOUR'] },
        { id: 'liv-golf', label: 'LIV Golf', categories: ['golf'], aliases: ['LIV'] }
      ]
    },
    {
      label: 'Darts',
      options: [
        { id: 'pdc-darts', label: 'PDC Darts', categories: ['darts'], aliases: ['PDC', 'Professional Darts Corporation', 'World Darts Championship'] }
      ]
    }
  ];

  var ALL_CURATED_LEAGUE_IDS = [];
  for (var i = 0; i < LIVE_LEAGUE_GROUPS.length; i++) {
    var grp = LIVE_LEAGUE_GROUPS[i];
    for (var j = 0; j < grp.options.length; j++) {
      ALL_CURATED_LEAGUE_IDS.push(grp.options[j].id);
    }
  }

  return {
    LIVE_LEAGUE_GROUPS: LIVE_LEAGUE_GROUPS,
    ALL_CURATED_LEAGUE_IDS: ALL_CURATED_LEAGUE_IDS,
    normalizeLeagueName: normalizeLeagueName
  };
});
