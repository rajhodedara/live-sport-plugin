/**
 * ChannelLogoService.js
 *
 * Single source of truth for 24/7 sports channel -> logo mapping.
 * Uses high-speed jsDelivr Cloudflare CDN backed by the curated tv-logo repository.
 * Completely replaces broken Wikimedia thumbnail URLs (which return 400 Bad Request).
 *
 * Matching: exact normalized key first, then aliases, then longest substring wins.
 */

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/tv-logo/tv-logos@main';

const CHANNEL_LOGOS = {
  // --- F1 & Motorsport ---
  "sky sports f1": `${CDN_BASE}/countries/united-kingdom/sky-sports-f1-uk.png`,
  "f1 tv": `${CDN_BASE}/countries/united-kingdom/sky-sports-f1-uk.png`,
  "formula 1": `${CDN_BASE}/countries/united-kingdom/sky-sports-f1-uk.png`,
  "rally tv": `${CDN_BASE}/countries/australia/fox-sports-theme-motorsport-au.png`,
  "motogp": `${CDN_BASE}/countries/italy/sky-sport-motogp-it.png`,

  // --- Baseball (MLB) ---
  "mlb strike zone": `${CDN_BASE}/countries/united-states/mlb-network-strike-zone-us.png`,
  "mlb strikezone": `${CDN_BASE}/countries/united-states/mlb-network-strike-zone-us.png`,
  "mlb network": `${CDN_BASE}/countries/united-states/mlb-network-us.png`,

  // --- American Football (NFL) ---
  "nfl redzone": `${CDN_BASE}/countries/united-states/nfl-red-zone-us.png`,
  "nfl red zone": `${CDN_BASE}/countries/united-states/nfl-red-zone-us.png`,
  "redzone": `${CDN_BASE}/countries/united-states/nfl-red-zone-us.png`,
  "nfl network": `${CDN_BASE}/countries/united-states/nfl-network-us.png`,

  // --- Basketball (NBA) ---
  "nba tv": `${CDN_BASE}/countries/united-states/nba-tv-us.png`,

  // --- Hockey (NHL) ---
  "nhl network": `${CDN_BASE}/countries/united-states/nhl-network-us.png`,

  // --- Tennis ---
  "tennis channel": `${CDN_BASE}/countries/united-states/tennis-channel-us.png`,

  // --- Cricket ---
  "willow cricket": `${CDN_BASE}/countries/united-states/willow-us.png`,
  "willow": `${CDN_BASE}/countries/united-states/willow-us.png`,
  "fox cricket": `${CDN_BASE}/countries/australia/fox-sports-cricket-501-au.png`,
  "sky sports cricket": `${CDN_BASE}/countries/united-kingdom/sky-sports-cricket-uk.png`,
  "astro cricket": `${CDN_BASE}/countries/malaysia/astro-cricket-my.png`,

  // --- Sky Sports Suite (UK) ---
  "sky sports main event": `${CDN_BASE}/countries/united-kingdom/sky-sports-main-event-uk.png`,
  "sky sports premier league": `${CDN_BASE}/countries/united-kingdom/sky-sports-premier-league-uk.png`,
  "sky sports football": `${CDN_BASE}/countries/united-kingdom/sky-sports-football-uk.png`,
  "sky sports action": `${CDN_BASE}/countries/united-kingdom/sky-sports-action-uk.png`,
  "sky sports arena": `${CDN_BASE}/countries/united-kingdom/sky-sports-arena-uk.png`,
  "sky sports golf": `${CDN_BASE}/countries/united-kingdom/sky-sports-golf-uk.png`,
  "sky sports racing": `${CDN_BASE}/countries/united-kingdom/sky-sports-racing-uk.png`,
  "sky sports tennis": `${CDN_BASE}/countries/united-kingdom/sky-sports-tennis-uk.png`,
  "sky sports news": `${CDN_BASE}/countries/united-kingdom/sky-sports-news-uk.png`,
  "sky sports": `${CDN_BASE}/countries/united-kingdom/sky-sports-hz-uk.png`,

  // --- TNT Sports Suite (UK) ---
  "tnt sports 1": `${CDN_BASE}/countries/united-kingdom/tnt-sports-1-uk.png`,
  "tnt sports 2": `${CDN_BASE}/countries/united-kingdom/tnt-sports-2-uk.png`,
  "tnt sports 3": `${CDN_BASE}/countries/united-kingdom/tnt-sports-3-uk.png`,
  "tnt sports 4": `${CDN_BASE}/countries/united-kingdom/tnt-sports-4-uk.png`,
  "tnt sports": `${CDN_BASE}/countries/united-kingdom/tnt-sports-1-uk.png`,
  "tnt sport 1": `${CDN_BASE}/countries/united-kingdom/tnt-sports-1-uk.png`,
  "tnt sport 2": `${CDN_BASE}/countries/united-kingdom/tnt-sports-2-uk.png`,
  "tnt sport 3": `${CDN_BASE}/countries/united-kingdom/tnt-sports-3-uk.png`,
  "tnt sport 4": `${CDN_BASE}/countries/united-kingdom/tnt-sports-4-uk.png`,
  "tnt sport": `${CDN_BASE}/countries/united-kingdom/tnt-sports-1-uk.png`,
  "magenta sport": `${CDN_BASE}/countries/austria/magenta-sport-1-at.png`,
  "blue sport": `${CDN_BASE}/countries/switzerland/my-sports-eins-ch.png`,

  // --- Eurosport ---
  "eurosport 1": `${CDN_BASE}/countries/united-kingdom/eurosport-1-uk.png`,
  "eurosport 2": `${CDN_BASE}/countries/united-kingdom/eurosport-2-uk.png`,
  "eurosport": `${CDN_BASE}/countries/united-kingdom/eurosport-1-uk.png`,

  // --- ESPN Suite (US) ---
  "espn 2": `${CDN_BASE}/countries/united-states/espn-2-us.png`,
  "espn 3": `${CDN_BASE}/countries/united-states/espn-3-us.png`,
  "espnu": `${CDN_BASE}/countries/united-states/espn-u-us.png`,
  "espnews": `${CDN_BASE}/countries/united-states/espnews-us.png`,
  "espn deportes": `${CDN_BASE}/countries/united-states/espn-deportes-us.png`,
  "espn": `${CDN_BASE}/countries/united-states/espn-us.png`,

  // --- Fox Sports Suite (US & Australia) ---
  "fox sports 1": `${CDN_BASE}/countries/united-states/fox-sports-1-us.png`,
  "fox sports 2": `${CDN_BASE}/countries/united-states/fox-sports-2-us.png`,
  "fs1": `${CDN_BASE}/countries/united-states/fox-sports-1-us.png`,
  "fs2": `${CDN_BASE}/countries/united-states/fox-sports-2-us.png`,
  "fox deportes": `${CDN_BASE}/countries/united-states/fox-sports-deportes-us.png`,
  "fox league": `${CDN_BASE}/countries/australia/fox-sports-league-502-au.png`,
  "fox footy": `${CDN_BASE}/countries/australia/fox-sports-footy-504-au.png`,
  "fox sports": `${CDN_BASE}/countries/united-states/fox-sports-us.png`,

  // --- CBS & NBC Sports ---
  "cbs sports network": `${CDN_BASE}/countries/united-states/cbs-sports-network-us.png`,
  "cbs sports golazo network": `${CDN_BASE}/countries/united-states/cbs-sports-golazo-network-us.png`,
  "cbs sports golazo": `${CDN_BASE}/countries/united-states/cbs-sports-golazo-network-us.png`,
  "golazo": `${CDN_BASE}/countries/united-states/cbs-sports-golazo-network-us.png`,
  "cbs sports": `${CDN_BASE}/countries/united-states/cbs-sports-network-us.png`,
  "nbc sports bay area": `${CDN_BASE}/countries/united-states/nbcsn-bay-area-us.png`,
  "nbc sports": `${CDN_BASE}/countries/united-states/nbc-sports-us.png`,

  // --- beIN Sports ---
  "bein sports usa": `${CDN_BASE}/countries/united-states/bein-sports-us.png`,
  "bein sports xtra": `${CDN_BASE}/countries/united-states/bein-sports-xtra-us.png`,
  "bein sports": `${CDN_BASE}/countries/france/bein-sports-fr.png`,

  // --- Canadian Networks ---
  "tsn 1": `${CDN_BASE}/countries/canada/tsn-1-ca.png`,
  "tsn 2": `${CDN_BASE}/countries/canada/tsn-2-ca.png`,
  "tsn 3": `${CDN_BASE}/countries/canada/tsn-3-ca.png`,
  "tsn 4": `${CDN_BASE}/countries/canada/tsn-4-ca.png`,
  "tsn 5": `${CDN_BASE}/countries/canada/tsn-5-ca.png`,
  "tsn": `${CDN_BASE}/countries/canada/tsn-ca.png`,
  "sportsnet ontario": `${CDN_BASE}/countries/canada/sportsnet-ontario-ca.png`,
  "sportsnet east": `${CDN_BASE}/countries/canada/sportsnet-east-ca.png`,
  "sportsnet pacific": `${CDN_BASE}/countries/canada/sportsnet-pacific-ca.png`,
  "sportsnet west": `${CDN_BASE}/countries/canada/sportsnet-west-ca.png`,
  "sportsnet one": `${CDN_BASE}/countries/canada/sportsnet-one-ca.png`,
  "sportsnet": `${CDN_BASE}/countries/canada/sportsnet-ca.png`,
  "fight network": `${CDN_BASE}/countries/canada/fight-network-ca.png`,

  // --- International / Regional Sports ---
  "super sport": `${CDN_BASE}/countries/south-africa/supersport-za.png`,
  "supersport grandstand": `${CDN_BASE}/countries/south-africa/supersport-grandstand-za.png`,
  "supersport": `${CDN_BASE}/countries/south-africa/supersport-za.png`,
  "star sports 1": `${CDN_BASE}/countries/india/star-sports-1-in.png`,
  "star sports": `${CDN_BASE}/countries/india/star-sports-1-in.png`,
  "optus sport": `${CDN_BASE}/countries/australia/optus-sport-au.png`,
  "bally sports": `${CDN_BASE}/countries/united-states/bally-sports-us.png`,
  "arena sport": `${CDN_BASE}/countries/croatia/arena-sport-1-hr.png`,
  "astro supersport": `${CDN_BASE}/countries/malaysia/screen-bug/astro-supersport-bug-my.png`,
  "nova sports premier league": `${CDN_BASE}/countries/greece/nova-sports-1-gr.png`,
  "nova sports premier league greece": `${CDN_BASE}/countries/greece/nova-sports-1-gr.png`,
  "chicago sports network": `${CDN_BASE}/countries/united-states/nbc-sports-chicago-us.png`,
};

// Aliases for common alternative channel spellings and feed titles
const CHANNEL_ALIASES = {
  "sky f1": "sky sports f1",
  "skysports f1": "sky sports f1",
  "strike zone": "mlb strike zone",
  "strikezone": "mlb strike zone",
  "mlb strike": "mlb strike zone",
  "nfl red zone": "nfl redzone",
  "red zone": "nfl redzone",
  "willow tv": "willow",
  "willow hd": "willow",
  "sky cricket": "sky sports cricket",
  "sky football": "sky sports football",
  "sky premier league": "sky sports premier league",
  "sky main event": "sky sports main event",
  "tnt 1": "tnt sports 1",
  "tnt 2": "tnt sports 2",
};

// Longest keys first so "sky sports cricket" beats "sky sports"
const SORTED_KEYS = Object.entries(CHANNEL_LOGOS).sort((a, b) => b[0].length - a[0].length);

let TV_LOGOS_MAP = null;
try {
  TV_LOGOS_MAP = require('../data/tv_logos_map.json');
} catch (_) {
  try {
    TV_LOGOS_MAP = require('../../scratch/tv_logos_map.json');
  } catch (_2) {
    TV_LOGOS_MAP = {};
  }
}

const NUMBER_WORDS = {
  "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
  "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10"
};

const COUNTRY_SUFFIXES = [
  "usa", "us", "uk", "italy", "it", "germany", "de", "spain", "es", "france", "fr",
  "netherlands", "nl", "poland", "pl", "portugal", "pt", "serbia", "croatia", "bulgaria",
  "uae", "nz", "au", "ca", "bih", "turkey", "tr", "arabic", "brasil", "br", "malaysia",
  "my", "pk", "qatar", "mexico", "mx", "argentina", "ar", "chile", "cl", "colombia", "co",
  "romania", "ro", "hungary", "hu", "czech", "cz", "slovakia", "sk", "austria", "at",
  "switzerland", "ch", "sweden", "se", "norway", "no", "denmark", "dk", "finland", "fi",
  "greece", "gr", "cyprus", "cy", "albania", "al", "israel", "il", "india", "in", "japan", "jp",
  "afrique", "canada", "russia", "ru", "uruguay", "columbia"
];
const COUNTRY_REGEX = new RegExp(`-(?:${COUNTRY_SUFFIXES.join("|")})$`);
const QUALITY_REGEX = /-(?:hd|fhd|uhd|4k|sd|raw|live|stream|vip|premium|channel|tv)$/;

const BRAND_DEFAULTS = [
  ["sky-sports", "countries/united-kingdom/sky-sports-hz-uk.png"],
  ["tnt-sports", "countries/united-kingdom/tnt-sports-1-uk.png"],
  ["eurosport", "countries/united-kingdom/eurosport-1-uk.png"],
  ["espn", "countries/united-states/espn-us.png"],
  ["fox-sports", "countries/united-states/fox-sports-us.png"],
  ["sportsnet", "countries/canada/sportsnet-ca.png"],
  ["tsn", "countries/canada/tsn-ca.png"],
  ["ziggo-sport", "countries/netherlands/ziggo-sport-nl.png"],
  ["viaplay", "countries/netherlands/viaplay-nl.png"],
  ["dazn", "countries/international/dazn-int.png"],
  ["optus-sport", "countries/australia/optus-sport-au.png"],
  ["star-sports", "countries/india/star-sports-1-in.png"],
  ["premier-sports", "countries/united-kingdom/premier-sports-1-uk.png"],
  ["willow", "countries/united-states/willow-us.png"],
  ["cbs-sports", "countries/united-states/cbs-sports-network-us.png"],
  ["nbc-sports", "countries/united-states/nbc-sports-us.png"],
  ["abu-dhabi-sports", "countries/united-arab-emirates/abu-dhabi-sports-tv-ae.png"],
  ["bbc-news", "countries/united-kingdom/bbc-news-uk.png"],
  ["bbc", "countries/united-kingdom/bbc-news-uk.png"],
  ["e-entertainment", "countries/united-states/e-entertainment-us.png"]
];

function slugify(str) {
  if (!str) return '';
  return String(str).toLowerCase()
    .replace(/&amp;/g, " and ")
    .replace(/&/g, " and ")
    .replace(/&#039;/g, "")
    .replace(/\+/g, " plus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanChannelTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .replace(/\b(24\/7|live|stream|hd|fhd|4k|uhd|raw|en|us|uk)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryFindLogo(candidate) {
  if (!candidate || !TV_LOGOS_MAP) return null;
  if (TV_LOGOS_MAP[candidate]) return TV_LOGOS_MAP[candidate];

  // If candidate had a US suffix, prefer the -us asset before generic
  if (/-(usa|us)$/.test(candidate)) {
    const usKey = candidate.replace(/-(usa|us)$/, "") + "-us";
    if (TV_LOGOS_MAP[usKey]) return TV_LOGOS_MAP[usKey];
  }

  const sc = candidate.replace(COUNTRY_REGEX, "");
  if (TV_LOGOS_MAP[sc]) return TV_LOGOS_MAP[sc];
  const sq = sc.replace(QUALITY_REGEX, "");
  if (TV_LOGOS_MAP[sq]) return TV_LOGOS_MAP[sq];
  const sqc = candidate.replace(QUALITY_REGEX, "").replace(COUNTRY_REGEX, "");
  if (TV_LOGOS_MAP[sqc]) return TV_LOGOS_MAP[sqc];
  return null;
}

function resolveDeepLogo(title) {
  if (!title || !TV_LOGOS_MAP) return null;
  const clean = String(title).trim();
  const slug = slugify(clean);

  // 0. Major US networks (ABC, CBS, NBC, Fox, PBS, CW)
  if (/^(abc|cbs|nbc|fox|pbs|cw)(-[a-z0-9]+)*-(usa|us)$/.test(slug) || ["abc", "cbs", "nbc", "fox", "pbs", "cw", "foxny-usa", "cbsny-usa", "nbcny-usa", "nbc10-philadelphia", "cw-philly"].includes(slug)) {
    const baseNet = slug.split("-")[0].replace(/(ny|10)$/, "");
    if (baseNet === "cbs" && TV_LOGOS_MAP["cbs-logo-white-us"]) return TV_LOGOS_MAP["cbs-logo-white-us"];
    if (TV_LOGOS_MAP[`${baseNet}-us`]) return TV_LOGOS_MAP[`${baseNet}-us`];
    if (TV_LOGOS_MAP[baseNet]) return TV_LOGOS_MAP[baseNet];
  }

  // 1. Direct candidate
  let res = tryFindLogo(slug);
  if (res) return res;


  // 2. Parentheses e.g. "AHC (American Heroes Channel)"
  const parenMatch = clean.match(/^(.*?)\s*\((.*?)\)$/);
  if (parenMatch) {
    res = tryFindLogo(slugify(parenMatch[1])) || tryFindLogo(slugify(parenMatch[2]));
    if (res) return res;
  }

  // 3. Russian Match TV translation
  if (slug.includes("match-football") || slug.includes("match-futbol")) {
    const num = slug.match(/\d+/);
    if (num && TV_LOGOS_MAP[`match-futbol-${num[0]}-ru`]) return TV_LOGOS_MAP[`match-futbol-${num[0]}-ru`];
    if (num && TV_LOGOS_MAP[`match-futbol-${num[0]}`]) return TV_LOGOS_MAP[`match-futbol-${num[0]}`];
  }
  if (slug.includes("match-premier") && TV_LOGOS_MAP["match-premier-ru"]) return TV_LOGOS_MAP["match-premier-ru"];
  if ((slug.includes("match-tv") || slug === "match") && TV_LOGOS_MAP["match-ru"]) return TV_LOGOS_MAP["match-ru"];
  if (clean.includes("МАТЧ") && TV_LOGOS_MAP["match-boets-ru"]) return TV_LOGOS_MAP["match-boets-ru"];

  // 4. Number words conversion
  const numSlug = slug.split("-").map(w => NUMBER_WORDS[w] || w).join("-");
  if (numSlug !== slug) {
    res = tryFindLogo(numSlug);
    if (res) return res;
  }

  // 5. Sport TV Portugal: sport-tv1 -> sport-tv-1
  if (slug.includes("sport-tv")) {
    const num = slug.match(/sport-tv-?(\d+)/);
    if (num && TV_LOGOS_MAP[`sport-tv-${num[1]}-pt`]) return TV_LOGOS_MAP[`sport-tv-${num[1]}-pt`];
    if (num && TV_LOGOS_MAP[`sport-tv-${num[1]}`]) return TV_LOGOS_MAP[`sport-tv-${num[1]}`];
  }

  // 6. Sportklub / Sport Klub
  if (slug.includes("sport-klub") || slug.includes("sportklub")) {
    const num = slug.match(/sport-?klub-?(\d+)/);
    if (num && TV_LOGOS_MAP[`sportklub-${num[1]}-hd-hr`]) return TV_LOGOS_MAP[`sportklub-${num[1]}-hd-hr`];
    if (TV_LOGOS_MAP["sportklub-1-hd-hr"]) return TV_LOGOS_MAP["sportklub-1-hd-hr"];
  }

  // 7. Polsat Sport
  if (slug.includes("polsat-sport")) {
    const num = slug.match(/polsat-sport-(?:premium-)?(\d+)/);
    if (num && TV_LOGOS_MAP[`polsat-sport-${num[1]}-pl`]) return TV_LOGOS_MAP[`polsat-sport-${num[1]}-pl`];
    if (TV_LOGOS_MAP["polsat-sport-1-pl"]) return TV_LOGOS_MAP["polsat-sport-1-pl"];
  }

  // 8. Italian Sky Sport & Calcio
  if (slug.includes("sky-calcio") || (slug.includes("sky-sport") && slug.includes("italy"))) {
    if (slug.includes("calcio") && TV_LOGOS_MAP["sky-sport-calcio-hd-it"]) return TV_LOGOS_MAP["sky-sport-calcio-hd-it"];
    if (slug.includes("basket") && TV_LOGOS_MAP["sky-sport-basket-hd-it"]) return TV_LOGOS_MAP["sky-sport-basket-hd-it"];
    if (TV_LOGOS_MAP["sky-sport-uno-hd-it"]) return TV_LOGOS_MAP["sky-sport-uno-hd-it"];
  }

  // 9. Formula / MotoGP
  if (slug.includes("formula")) {
    res = tryFindLogo(slug.replace(/formula-1/g, "formula1"));
    if (res) return res;
  }
  if (slug.includes("motogp") || slug.includes("moto-gp")) {
    res = tryFindLogo(slug.replace(/moto-gp/g, "motogp"));
    if (res) return res;
  }

  // 10. RedZone / Fox Cricket / Rally TV / WWE Network
  if (slug.includes("redzone") || slug.includes("red-zone")) {
    return TV_LOGOS_MAP["nfl-red-zone-us"] || TV_LOGOS_MAP["nfl-red-zone"];
  }
  if (slug.includes("fox-cricket")) {
    return TV_LOGOS_MAP["fox-sports-cricket-501-au"];
  }
  if (slug.includes("rally-tv") || slug.includes("rallytv")) {
    return TV_LOGOS_MAP["wrc-plus"] || "countries/australia/fox-sports-theme-motorsport-au.png";
  }
  if (slug.includes("wwe")) {
    return TV_LOGOS_MAP["supersport-wwe-za"] || "countries/south-africa/supersport-wwe-za.png";
  }

  // 11. Specific feeds
  if (slug.startsWith("18-plus") || slug.startsWith("18-player")) {
    return null; // no verified asset
  }
  if (slug.startsWith("big-brother")) {
    return TV_LOGOS_MAP["big-brother-al"] || "countries/united-states/cbs-logo-white-us.png";
  }
  if (slug.startsWith("alkass") || slug.startsWith("ssc-sport")) {
    return "countries/united-arab-emirates/dubai-sports-tv-ae.png";
  }
  if (slug.includes("israel") && (slug.includes("sport") || slug.includes("one"))) {
    return "countries/international/dazn-int.png";
  }
  if (slug.startsWith("cytavision")) {
    return null; // no verified asset
  }
  if (slug.startsWith("voyo")) {
    return TV_LOGOS_MAP["markiza-dajto-sk"] || "countries/slovakia/markiza-dajto-sk.png";
  }
  if (slug.includes("benfica")) {
    return TV_LOGOS_MAP["btv-hd-pt"] || TV_LOGOS_MAP["btv-pt"];
  }

  // 12. FanDuel / Bally Sports
  if (slug.includes("fanduel")) {
    res = tryFindLogo(slug.replace(/fanduel-sports(-network)?/, "bally-sports")) || TV_LOGOS_MAP["bally-sports"];
    if (res) return res;
  }

  // 13. Astro SuperSport
  if (slug.startsWith("astro-supersport")) {
    const num = slug.match(/astro-supersport-(\d+)/);
    if (num && TV_LOGOS_MAP[`astro-supersport-${num[1]}-bug`]) return TV_LOGOS_MAP[`astro-supersport-${num[1]}-bug`];
    if (TV_LOGOS_MAP["astro-supersport-bug"]) return TV_LOGOS_MAP["astro-supersport-bug"];
  }

  // 14. Arena Sport
  if (slug.includes("arena-sport")) {
    const num = slug.match(/arena-sport(?:s)?-(\d+)/);
    if (num) {
      if (TV_LOGOS_MAP[`arena-sport-${num[1]}`]) return TV_LOGOS_MAP[`arena-sport-${num[1]}`];
      if (TV_LOGOS_MAP[`arena-sport-${num[1]}-hr`]) return TV_LOGOS_MAP[`arena-sport-${num[1]}-hr`];
    }
    if (TV_LOGOS_MAP["arena-sport-1"]) return TV_LOGOS_MAP["arena-sport-1"];
  }

  // 15. beIN Sports
  if (slug.includes("bein-sport")) {
    const maxNum = slug.match(/max-(\d+)/);
    if (maxNum && TV_LOGOS_MAP[`bein-sports-${maxNum[1]}-max-hz`]) return TV_LOGOS_MAP[`bein-sports-${maxNum[1]}-max-hz`];
    const num = slug.match(/bein-sports?-(?:hd)?(\d+)/);
    if (num) {
      if (TV_LOGOS_MAP[`bein-sports-${num[1]}-hz`]) return TV_LOGOS_MAP[`bein-sports-${num[1]}-hz`];
      if (TV_LOGOS_MAP[`bein-sports-${num[1]}`]) return TV_LOGOS_MAP[`bein-sports-${num[1]}`];
    }
    if (TV_LOGOS_MAP["bein-sports"]) return TV_LOGOS_MAP["bein-sports"];
  }

  // 16. Diema Sport
  if (slug.includes("diema-sport")) {
    const num = slug.match(/\d+/);
    if (num && TV_LOGOS_MAP[`diema-sport${num[0]}-hd-bg`]) return TV_LOGOS_MAP[`diema-sport${num[0]}-hd-bg`];
    if (TV_LOGOS_MAP["diema-sport-hd-bg"]) return TV_LOGOS_MAP["diema-sport-hd-bg"];
  }

  // 17. Dubai Sports & Racing
  if (slug.includes("dubai-sport") && TV_LOGOS_MAP["dubai-sports-tv-ae"]) return TV_LOGOS_MAP["dubai-sports-tv-ae"];
  if (slug.includes("dubai-racing") && TV_LOGOS_MAP["dubai-racing-tv-ae"]) return TV_LOGOS_MAP["dubai-racing-tv-ae"];

  // 18. SuperSport (ZA)
  if (slug.startsWith("supersport") || slug.startsWith("super-sport")) {
    const num = slug.match(/supersport-(\d+)/) || slug.match(/super-sport-(\d+)/);
    if (num && TV_LOGOS_MAP[`supersport-${num[1]}`]) return TV_LOGOS_MAP[`supersport-${num[1]}`];
    if (TV_LOGOS_MAP["supersport-za"]) return TV_LOGOS_MAP["supersport-za"];
    if (TV_LOGOS_MAP["supersport"]) return TV_LOGOS_MAP["supersport"];
  }

  // 19. Canal+
  if (slug.startsWith("canal-plus")) {
    const sub = slug.replace(COUNTRY_REGEX, "").replace(QUALITY_REGEX, "");
    if (TV_LOGOS_MAP[sub]) return TV_LOGOS_MAP[sub];
    if (TV_LOGOS_MAP[`${sub}-fr`]) return TV_LOGOS_MAP[`${sub}-fr`];
    if (TV_LOGOS_MAP[`${sub}-pl`]) return TV_LOGOS_MAP[`${sub}-pl`];
    if (slug.includes("sport") && TV_LOGOS_MAP["canal-plus-sport-fr"]) return TV_LOGOS_MAP["canal-plus-sport-fr"];
    if (TV_LOGOS_MAP["canal-plus-fr"]) return TV_LOGOS_MAP["canal-plus-fr"];
  }

  // 20. Movistar Plus (Spain)
  if (slug.includes("movistar")) {
    const num = slug.match(/deportes-(\d+)/);
    if (num && TV_LOGOS_MAP[`deportes-${num[1]}-por-movistar-plus`]) return TV_LOGOS_MAP[`deportes-${num[1]}-por-movistar-plus`];
    if (slug.includes("golf") && TV_LOGOS_MAP["canal-plus-golf"]) return TV_LOGOS_MAP["canal-plus-golf"];
    if (TV_LOGOS_MAP["deportes-2-por-movistar-plus"]) return TV_LOGOS_MAP["deportes-2-por-movistar-plus"];
  }

  // 21. TV 2 Sport (Norway / Denmark)
  if (slug.startsWith("tv-2-sport") || slug.startsWith("tv2-sport")) {
    const num = slug.match(/tv-?2-sport-?(\d+)/);
    if (num && TV_LOGOS_MAP[`tv2-sport${num[1]}-no`]) return TV_LOGOS_MAP[`tv2-sport${num[1]}-no`];
    if (TV_LOGOS_MAP["tv2-sport1-no"]) return TV_LOGOS_MAP["tv2-sport1-no"];
    if (TV_LOGOS_MAP["tv2-sport-dk"]) return TV_LOGOS_MAP["tv2-sport-dk"];
  }

  // 22. Major US networks: ABC, CBS, NBC, Fox, PBS, CW
  if (/^(abc|cbs|nbc|fox|pbs|cw)(-[a-z0-9]+)*-(usa|us)$/.test(slug) || ["abc", "cbs", "nbc", "fox", "pbs", "cw", "foxny-usa", "cbsny-usa", "nbcny-usa", "nbc10-philadelphia", "cw-philly"].includes(slug)) {
    const baseNet = slug.split("-")[0].replace(/(ny|10)$/, "");
    if (baseNet === "cbs" && TV_LOGOS_MAP["cbs-logo-white-us"]) return TV_LOGOS_MAP["cbs-logo-white-us"];
    if (TV_LOGOS_MAP[`${baseNet}-us`]) return TV_LOGOS_MAP[`${baseNet}-us`];
    if (TV_LOGOS_MAP[baseNet]) return TV_LOGOS_MAP[baseNet];
  }

  // 23. Specific Brand Aliases
  if (slug.includes("bandsport")) return TV_LOGOS_MAP["band-sports-br"] || TV_LOGOS_MAP["band-sports"];
  if (slug.includes("dajto")) return TV_LOGOS_MAP["markiza-dajto-sk"] || TV_LOGOS_MAP["markiza-dajto"];
  if (slug.includes("joj")) return TV_LOGOS_MAP["joj-sport-sk"] || TV_LOGOS_MAP["joj-sport"];
  if (slug.includes("canal-5")) return TV_LOGOS_MAP["canal-5-mx"] || TV_LOGOS_MAP["canal-5"];
  if (slug.includes("citytv")) return TV_LOGOS_MAP["ctv-ca"] || TV_LOGOS_MAP["citytv"];
  if (slug.includes("lequipe")) return TV_LOGOS_MAP["lequipe-fr"] || TV_LOGOS_MAP["lequipe"];
  if (slug.includes("lasexta") || slug.includes("la-sexta")) return TV_LOGOS_MAP["lasexta-es"] || TV_LOGOS_MAP["lasexta"];
  if (slug.includes("liverpool") || slug.includes("lfc-tv")) return TV_LOGOS_MAP["lfctv-uk"] || TV_LOGOS_MAP["lfctv"];
  if (slug.includes("msnbc")) return TV_LOGOS_MAP["msnbc-hz-us"] || TV_LOGOS_MAP["msnbc-hz"];
  if (slug.includes("m4-sport")) return TV_LOGOS_MAP["m4-sport-hu"] || TV_LOGOS_MAP["m4-sport"];
  if (slug.includes("hallmark")) return slug.includes("myster") ? TV_LOGOS_MAP["hallmark-mystery-us"] : TV_LOGOS_MAP["hallmark-channel-us"];
  if (slug.includes("fx-movie") || slug === "fxm") return TV_LOGOS_MAP["fxm-movie-channel-us"] || TV_LOGOS_MAP["fxm"];
  if (slug.includes("galavision")) return TV_LOGOS_MAP["galavision-us"];
  if (slug.includes("globo")) return TV_LOGOS_MAP["globo-br"];
  if (slug.includes("hbo")) return TV_LOGOS_MAP["hbo"];
  if (slug.includes("headline-news") || slug === "hln") return TV_LOGOS_MAP["hln-us"];
  if (slug.includes("lifetime")) return slug.includes("movie") ? TV_LOGOS_MAP["lifetime-movie-network"] : TV_LOGOS_MAP["lifetime"];
  if (slug.includes("kabel-eins") || slug.includes("kabel-1")) return TV_LOGOS_MAP["kabel-eins-austria"];
  if (slug.includes("laliga")) return TV_LOGOS_MAP["laliga-tv-no"];
  if (slug.includes("m-net")) return TV_LOGOS_MAP["m-net-channel-101-za"];
  if (slug.includes("mzansi")) return TV_LOGOS_MAP["mzansi-magic-za"];
  if (slug.includes("oneplay")) return TV_LOGOS_MAP["oneplay-sport-1-cz"];
  if (slug.includes("prosieben") || slug.includes("pro7")) return TV_LOGOS_MAP["prosieben-austria-at"];
  if (slug.includes("veronica")) return TV_LOGOS_MAP["veronica-nl"];
  if (slug.includes("food-network")) return TV_LOGOS_MAP["food-network-ca"] || TV_LOGOS_MAP["food-network"];
  if (slug.includes("weather-channel")) return TV_LOGOS_MAP["weather-channel-us"];
  if (slug.includes("root-sports")) return TV_LOGOS_MAP["root-sports-us"];
  if (slug.includes("mediaset")) return TV_LOGOS_MAP["mediaset-extra-it"];
  if (slug.includes("trutv")) return "countries/united-states/tru-tv-us.png";
  if (slug.includes("italia-1")) return TV_LOGOS_MAP["canale-italia-161-it"] || "countries/italy/hd/italia1-hd-it.png";

  // 24. Brand prefix defaults fallback
  for (const [prefix, logoPath] of BRAND_DEFAULTS) {
    if (slug.includes(prefix)) return logoPath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Fuzzy fallback over the curated map.
//
// Upstream channel titles frequently differ from the curated key only in
// separators, a quality/country suffix, or a singular/plural sport token
// ("Euro Sport 1" vs "eurosport-1", "Canal Sport 360" vs
// "canal-plus-sport-360-fr", "Altitude" vs "altitude-sports"). Without this the
// lookups returned null and the card rendered with no logo. Only ever consulted
// AFTER every exact/alias/substring/deep lookup has missed, so it cannot change
// an existing resolution.
// ---------------------------------------------------------------------------
// A lone generic word matches unrelated international feeds (e.g. "Canal" ->
// canal-4-ar, "Network" -> network-10-au). Those must never be auto-resolved;
// only the curated/alias tables may map them.
const GENERIC_SINGLE_TOKENS = new Set(['canal', 'tv', 'sport', 'sports', 'network', 'channel', 'live', 'hd', 'plus', 'news', 'one', 'max']);

let _compactIndex = null;  // compactKey -> [keys, shortest first]
let _tokenIndex = null;    // key -> normalized tokens

function buildMapIndexes() {
  if (_compactIndex) return;
  _compactIndex = new Map();
  _tokenIndex = new Map();
  for (const key of Object.keys(TV_LOGOS_MAP || {})) {
    const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!compact) continue;
    if (!_compactIndex.has(compact)) _compactIndex.set(compact, []);
    _compactIndex.get(compact).push(key);
    _tokenIndex.set(key, normalizeKeyTokens(key));
  }
  for (const list of _compactIndex.values()) list.sort((a, b) => a.length - b.length);
}

/** Split letter/digit runs so "sport360" -> ["sport","360"] and "tv2" -> ["tv","2"]. */
function normalizeKeyTokens(str) {
  return String(str)
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function resolveFuzzyMapMatch(title) {
  if (!title || !TV_LOGOS_MAP) return null;
  buildMapIndexes();
  const compact = slugify(title).replace(/-/g, '');
  if (!compact) return null;

  // (a) separator-insensitive exact match: "eurosport1" === "eurosport-1"
  if (_compactIndex.has(compact)) {
    for (const k of _compactIndex.get(compact)) if (TV_LOGOS_MAP[k]) return TV_LOGOS_MAP[k];
  }

  // (b) the query is a prefix of the key (shortest key wins): "altitude" ->
  //     "altitude-sports". Guarded on length so short tokens cannot match junk.
  // A single generic token must not prefix-match ("canal" -> canal-4-ar).
  const queryTokens = normalizeKeyTokens(title);
  const isGenericSingle = queryTokens.length === 1 && GENERIC_SINGLE_TOKENS.has(queryTokens[0]);
  if (compact.length >= 5 && !isGenericSingle) {
    let best = null;
    for (const [ck, list] of _compactIndex) {
      if (ck.length > compact.length && ck.startsWith(compact)) {
        if (!best || ck.length < best.ck.length) best = { ck, list };
      }
    }
    if (best) for (const k of best.list) if (TV_LOGOS_MAP[k]) return TV_LOGOS_MAP[k];
  }

  // (c) every query token appears in order within the key tokens (query must
  //     carry at least two tokens): "canal sport" -> "canal-plus-sport-fr".
  //     Fewest extra tokens wins, which prefers the generic feed over a
  //     numbered/regional variant.
  const qt = normalizeKeyTokens(title);
  // A lone generic word ("canal", "sport") matches unrelated international
  // feeds (e.g. "Canal" -> canal-4-ar). Those are left to the curated/alias
  // lookup; the fuzzy pass only handles multi-token or distinctive queries.
  if (qt.length >= 2 || (qt.length === 1 && !GENERIC_SINGLE_TOKENS.has(qt[0]))) {
    let best = null;
    for (const [key, kt] of _tokenIndex) {
      if (kt.length < qt.length) continue;
      let cursor = 0, all = true;
      for (const q of qt) {
        const idx = kt.indexOf(q, cursor);
        if (idx === -1) { all = false; break; }
        cursor = idx + 1;
      }
      if (!all) continue;
      const extra = kt.length - qt.length;
      if (!best || extra < best.extra || (extra === best.extra && key.length < best.key.length)) {
        best = { key, extra };
      }
    }
    if (best && TV_LOGOS_MAP[best.key]) return TV_LOGOS_MAP[best.key];
  }

  return null;
}

function getChannelLogo(title) {
  if (!title) return null;
  const rawLower = String(title).toLowerCase().trim();
  const cleaned = cleanChannelTitle(title);

  // 1. Direct exact match in curated list
  if (CHANNEL_LOGOS[rawLower]) return CHANNEL_LOGOS[rawLower];
  if (CHANNEL_LOGOS[cleaned]) return CHANNEL_LOGOS[cleaned];

  // 2. Direct alias match in curated aliases
  if (CHANNEL_ALIASES[rawLower] && CHANNEL_LOGOS[CHANNEL_ALIASES[rawLower]]) {
    return CHANNEL_LOGOS[CHANNEL_ALIASES[rawLower]];
  }
  if (CHANNEL_ALIASES[cleaned] && CHANNEL_LOGOS[CHANNEL_ALIASES[cleaned]]) {
    return CHANNEL_LOGOS[CHANNEL_ALIASES[cleaned]];
  }

  // 3. Substring match against cleaned and raw titles (longest key wins)
  for (const [key, logoUrl] of SORTED_KEYS) {
    if (cleaned.includes(key) || rawLower.includes(key)) {
      return logoUrl;
    }
  }

  // 4. Deep resolution engine using curated tv-logos repository
  const deepMatch = resolveDeepLogo(title);
  if (deepMatch) {
    if (deepMatch.startsWith('http://') || deepMatch.startsWith('https://')) {
      return deepMatch;
    }
    return `${CDN_BASE}/${deepMatch.replace(/^\/+/, '')}`;
  }

  // 5. Fuzzy match against the curated map (separator/suffix/spelling variants).
  const fuzzy = resolveFuzzyMapMatch(title);
  if (fuzzy) {
    if (fuzzy.startsWith('http://') || fuzzy.startsWith('https://')) return fuzzy;
    return `${CDN_BASE}/${fuzzy.replace(/^\/+/, '')}`;
  }

  return null;
}

module.exports = {
  getChannelLogo,
  cleanChannelTitle,
  CHANNEL_LOGOS,
  CDN_BASE
};

