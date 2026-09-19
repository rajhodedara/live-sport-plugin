/**
 * ChannelCountryService.js
 *
 * Maps live TV / sports broadcast channels (specifically all DaddyLive channels,
 * plus major international broadcasters) to their respective country, flag,
 * and primary commentary language.
 */

const COUNTRY_RULES = [
  // Israel
  {
    regex: /\b(Israel|Sport\s*[1-5](\s*Live|\s*Plus|\s*Stars)?\s*Israel|5\s*Plus\s*Israel)\b/i,
    flag: '🇮🇱',
    name: 'IL',
    country: 'Israel',
    language: 'Hebrew'
  },

  // United Kingdom
  {
    regex: /\b(UK|GB|Sky Sports.*UK|TNT Sports.*UK|BBC|ITV|Viaplay Sports.*UK|Virgin Media)\b/i,
    flag: '🇬🇧',
    name: 'UK',
    country: 'United Kingdom',
    language: 'English'
  },

  // Ireland
  {
    regex: /\b(Ireland|RTE|Premier Sports.*Ireland)\b/i,
    flag: '🇮🇪',
    name: 'IE',
    country: 'Ireland',
    language: 'English'
  },

  // Poland (match before generic Canal+)
  {
    regex: /\b(Poland|Polska|Polsat Sport|Canal\+ Sport Poland|Eleven Sports.*Poland|EuroSport.*Poland|TVP Sport|Motowizja)\b/i,
    flag: '🇵🇱',
    name: 'PL',
    country: 'Poland',
    language: 'Polish'
  },

  // France
  {
    regex: /\b(France|Canal\+ Sport 360|Canal\+ Sport360|Canal\+|TF1|L'Équipe|beIN Sports.*France|beIN Sports\s*[0-9]+.*France|beIN Sports 4 Max France)\b/i,
    flag: '🇫🇷',
    name: 'FR',
    country: 'France',
    language: 'French'
  },

  // United States - Hispanic / Spanish
  {
    regex: /\b(Telemundo|Univision|TUDN|FOX Deportes|NBC UNIVERSO|GOLTV)\b/i,
    flag: '🇺🇸',
    name: 'US',
    country: 'United States',
    language: 'Spanish'
  },

  // United States - English
  {
    regex: /\b(USA|US|NBC|NBCS|CBS|FOX\s*NY|FOXNY|Fox Soccer|ABC\s*NY|ABC|CW|BET|Bravo|History|HGTV|Freeform|A&E|MTV|truTV|TBS|TNT\s*USA|Space City|Altitude|Bally Sports|Monumental|Spectrum SportsNet|NESN|MASN|MSG|SEC Network|ACC Network|BTN|MLB Network|NBA TV|NFL Network|Golf Channel|Tennis Channel|Marquee Sports)\b/i,
    flag: '🇺🇸',
    name: 'US',
    country: 'United States',
    language: 'English'
  },

  // Canada
  {
    regex: /\b(Canada|TSN[1-5]?|Sportsnet)\b/i,
    flag: '🇨🇦',
    name: 'CA',
    country: 'Canada',
    language: 'English'
  },
  {
    regex: /\b(RDS|TVA Sports)\b/i,
    flag: '🇨🇦',
    name: 'CA',
    country: 'Canada',
    language: 'French'
  },

  // Australia
  {
    regex: /\b(Australia|Optus|Fox League|Fox Footy|Fox Cricket|Kayo)\b/i,
    flag: '🇦🇺',
    name: 'AU',
    country: 'Australia',
    language: 'English'
  },

  // New Zealand
  {
    regex: /\b(NZ|New Zealand|Sky Sport.*NZ)\b/i,
    flag: '🇳🇿',
    name: 'NZ',
    country: 'New Zealand',
    language: 'English'
  },

  // Netherlands
  {
    regex: /\b(NL|Netherlands|Nederland|Ziggo|NPO\s*3)\b/i,
    flag: '🇳🇱',
    name: 'NL',
    country: 'Netherlands',
    language: 'Dutch'
  },

  // Germany / Austria / Switzerland
  {
    regex: /\b(Sportdigital|Magenta Sport|Das Erste|Sport1(\+| Germany|\s*DE)?|DAZN[12]\s*DE|Sky Sport.*DE|Sky Sport Mix Germany|Bundesliga|Sky\s*Sports?\s*Bundesliga|Sky\s*Port\s*Bundesliga|Germany|DE)\b/i,
    flag: '🇩🇪',
    name: 'DE',
    country: 'Germany',
    language: 'German'
  },
  {
    regex: /\b(Austria|ORF)\b/i,
    flag: '🇦🇹',
    name: 'AT',
    country: 'Austria',
    language: 'German'
  },
  {
    regex: /\b(Schweiz|SRF|3 Schweiz)\b/i,
    flag: '🇨🇭',
    name: 'CH',
    country: 'Switzerland',
    language: 'German'
  },

  // Spain
  {
    regex: /\b(Spain|España|Movistar|#Vamos|Vamos|TVE La 1|Teledeporte|Deportes|Liga de Campeones)\b/i,
    flag: '🇪🇸',
    name: 'ES',
    country: 'Spain',
    language: 'Spanish'
  },

  // Italy
  {
    regex: /\b(Italy|Italia|Mediaset|RAI|Zona DAZN|Sky Sport.*IT)\b/i,
    flag: '🇮🇹',
    name: 'IT',
    country: 'Italy',
    language: 'Italian'
  },

  // Portugal
  {
    regex: /\b(Portugal|Sport TV|Canal 11|DAZN Eleven.*Portugal|RTP)\b/i,
    flag: '🇵🇹',
    name: 'PT',
    country: 'Portugal',
    language: 'Portuguese'
  },

  // Brazil
  {
    regex: /\b(Brazil|Brasil|SporTV|Sportv|Premier Brasil|ESPN.*BR|ESPN.*Brazil)\b/i,
    flag: '🇧🇷',
    name: 'BR',
    country: 'Brazil',
    language: 'Portuguese'
  },

  // Argentina / Mexico / Colombia / Uruguay (Latin America)
  {
    regex: /\b(Argentina|TYC Sports|TNT Sports Argentina|ESPN Argentina|ESPN2 Argentina)\b/i,
    flag: '🇦🇷',
    name: 'AR',
    country: 'Argentina',
    language: 'Spanish'
  },
  {
    regex: /\b(Mexico|México|Azteca|ESPN.*Mexico)\b/i,
    flag: '🇲🇽',
    name: 'MX',
    country: 'Mexico',
    language: 'Spanish'
  },
  {
    regex: /\b(Colombia|Caracol)\b/i,
    flag: '🇨🇴',
    name: 'CO',
    country: 'Colombia',
    language: 'Spanish'
  },
  {
    regex: /\b(Uruguay|VTV\+)\b/i,
    flag: '🇺🇾',
    name: 'UY',
    country: 'Uruguay',
    language: 'Spanish'
  },

  // Serbia / Croatia / Balkans
  {
    regex: /\b(Serbia|Sport Klub.*Serbia|Arena Sport.*Serbia|Arena.*Premium.*Serbia|RTS\s*1)\b/i,
    flag: '🇷🇸',
    name: 'RS',
    country: 'Serbia',
    language: 'Serbian'
  },
  {
    regex: /\b(Croatia|Hrvatska|Arena Sport.*Croatia|Nova TV Croatia)\b/i,
    flag: '🇭🇷',
    name: 'HR',
    country: 'Croatia',
    language: 'Croatian'
  },
  {
    regex: /\b(Slovenia|Slovenija|Arena Sport.*Slovenia|Sport Klub.*Slovenia|Šport TV)\b/i,
    flag: '🇸🇮',
    name: 'SI',
    country: 'Slovenia',
    language: 'Slovenian'
  },
  {
    regex: /\b(Bosnia|BiH|Arena Sport.*BiH)\b/i,
    flag: '🇧🇦',
    name: 'BA',
    country: 'Bosnia',
    language: 'Bosnian'
  },

  // Bulgaria
  {
    regex: /\b(Bulgaria|Diema Sport|MAX Sport|Nova Sport Bulgaria|BNT)\b/i,
    flag: '🇧🇬',
    name: 'BG',
    country: 'Bulgaria',
    language: 'Bulgarian'
  },

  // Greece / Cyprus
  {
    regex: /\b(Greece|Nova Sports.*Greece|Cosmote)\b/i,
    flag: '🇬🇷',
    name: 'GR',
    country: 'Greece',
    language: 'Greek'
  },
  {
    regex: /\b(Cyprus|Cytavision)\b/i,
    flag: '🇨🇾',
    name: 'CY',
    country: 'Cyprus',
    language: 'Greek'
  },

  // Turkey
  {
    regex: /\b(Turkey|Türkiye|TRT Spor|TV8 Turkey|SSport)\b/i,
    flag: '🇹🇷',
    name: 'TR',
    country: 'Turkey',
    language: 'Turkish'
  },

  // Romania
  {
    regex: /\b(Romania|Digi Sport.*Romania|Prima Sport.*Romania)\b/i,
    flag: '🇷🇴',
    name: 'RO',
    country: 'Romania',
    language: 'Romanian'
  },

  // Czech Republic & Slovakia
  {
    regex: /\b(Czech|Sport [12] Czech|Nova Sport [12] Czech|Sport 1 CZ)\b/i,
    flag: '🇨🇿',
    name: 'CZ',
    country: 'Czech Republic',
    language: 'Czech'
  },
  {
    regex: /\b(Slovakia|JOJ Sport)\b/i,
    flag: '🇸🇰',
    name: 'SK',
    country: 'Slovakia',
    language: 'Slovak'
  },

  // Hungary
  {
    regex: /\b(Hungary|M4 Sport|Sport [12] Hungary)\b/i,
    flag: '🇭🇺',
    name: 'HU',
    country: 'Hungary',
    language: 'Hungarian'
  },

  // Denmark / Norway / Sweden / Iceland (Nordic)
  {
    regex: /\b(Denmark|TV2 Sport.*Denmark|TV3 Sport.*Denmark|TV3\+.*Denmark)\b/i,
    flag: '🇩🇰',
    name: 'DK',
    country: 'Denmark',
    language: 'Danish'
  },
  {
    regex: /\b(Norway|TV2 Sport.*Norway)\b/i,
    flag: '🇳🇴',
    name: 'NO',
    country: 'Norway',
    language: 'Norwegian'
  },
  {
    regex: /\b(Sweden|Sverige|TV\s*4(\s+(Football|Fotboll|Hockey|Motor|Tennis|Sportkanalen|Live|Sport|Vinter))?|TV4|V Sport.*Sweden|V Sport.*Football|V Sport Premium|V Sport Vinter)\b/i,
    flag: '🇸🇪',
    name: 'SE',
    country: 'Sweden',
    language: 'Swedish'
  },
  {
    regex: /\b(Iceland|Stöð 2)\b/i,
    flag: '🇮🇸',
    name: 'IS',
    country: 'Iceland',
    language: 'Icelandic'
  },

  // Belgium
  {
    regex: /\b(Belgium|VTM)\b/i,
    flag: '🇧🇪',
    name: 'BE',
    country: 'Belgium',
    language: 'Dutch'
  },

  // Russia & Georgia
  {
    regex: /\b(Russia|Match TV|Match Igra|Match! Football|KHL)\b/i,
    flag: '🇷🇺',
    name: 'RU',
    country: 'Russia',
    language: 'Russian'
  },
  {
    regex: /\b(Georgia|1TV Georgia)\b/i,
    flag: '🇬🇪',
    name: 'GE',
    country: 'Georgia',
    language: 'Georgian'
  },

  // Middle East & North Africa (MENA)
  {
    regex: /\b(beIN Sports MENA English)\b/i,
    flag: '🇶🇦',
    name: 'MENA',
    country: 'Qatar / MENA',
    language: 'English'
  },
  {
    regex: /\b(MENA|beIN Sports MENA|SSC|Saudi|Jordan Sport)\b/i,
    flag: '🇸🇦',
    name: 'MENA',
    country: 'Saudi / MENA',
    language: 'Arabic'
  },

  // South Africa
  {
    regex: /\b(SuperSport)\b/i,
    flag: '🇿🇦',
    name: 'ZA',
    country: 'South Africa',
    language: 'English'
  },

  // India, Malaysia & Singapore
  {
    regex: /\b(India|Sony Ten|Star Sports|Willow)\b/i,
    flag: '🇮🇳',
    name: 'IN',
    country: 'India',
    language: 'English'
  },
  {
    regex: /\b(Malaysia|Astro|beIN Sports.*Malaysia)\b/i,
    flag: '🇲🇾',
    name: 'MY',
    country: 'Malaysia',
    language: 'English'
  },
  {
    regex: /\b(Singapore|StarHub|Hub Premier|Hub Sports)\b/i,
    flag: '🇸🇬',
    name: 'SG',
    country: 'Singapore',
    language: 'English'
  },

  // Generic Brand Fallbacks
  { regex: /\b(Sky Sports|TNT Sports)\b/i, flag: '🇬🇧', name: 'UK', country: 'United Kingdom', language: 'English' },
  { regex: /\b(ESPN|Fox Sports)\b/i, flag: '🇺🇸', name: 'US', country: 'United States', language: 'English' },
  { regex: /\b(Eurosport)\b/i, flag: '🇪🇺', name: 'EU', country: 'Europe', language: 'English' },

  // International Feeds
  {
    regex: /\b(Home Feed|Away Feed|Rally Tv|Vodafone Sport|Nat Geo Wild|Nick JR)\b/i,
    flag: '🌍',
    name: 'INT',
    country: 'International',
    language: 'English'
  }
];

class ChannelCountryService {
  /**
   * Detects country, flag, and commentary language for a given channel name.
   * @param {string} channelName
   * @returns {{ flag: string, name: string, country: string, language: string } | null}
   */
  static detectChannelCountry(channelName) {
    if (!channelName || typeof channelName !== 'string') return null;
    const cn = ' ' + channelName.trim() + ' ';
    for (const rule of COUNTRY_RULES) {
      if (rule.regex.test(cn)) {
        return {
          flag: rule.flag,
          name: rule.name,
          country: rule.country,
          language: rule.language
        };
      }
    }
    return null;
  }

  /**
   * Generates a formatted country & language tag for stream titles.
   * e.g., " 🇮🇱 [IL • Hebrew]" or " 🇬🇧 [UK • English]"
   * @param {string} channelName
   * @returns {string}
   */
  static formatCountryTag(channelName) {
    const info = ChannelCountryService.detectChannelCountry(channelName);
    if (!info) return '';
    return ` ${info.flag} [${info.name} • ${info.language}]`;
  }

  static getRules() {
    return COUNTRY_RULES;
  }
}

module.exports = ChannelCountryService;
