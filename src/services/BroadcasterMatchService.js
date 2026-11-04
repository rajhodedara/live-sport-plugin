'use strict';

/**
 * BroadcasterMatchService
 *
 * Bridges live match fixtures (scraped from DaddyLive, TheSportsDB, etc.)
 * to high-definition 1080p/4K 50fps Vavoo Sunshine CDN streams.
 *
 * Maintains an in-memory O(1) normalized index from TV network / broadcaster names
 * (e.g., "TNT Sports 1", "Sky Sports Main Event", "Movistar LaLiga", "Canal+ Sport")
 * to the corresponding active Vavoo channels.
 */

const fs = require('fs');
const path = require('path');
const ChannelCountryService = require('./ChannelCountryService');

const COUNTRY_ALIASES = {
  'united kingdom': ['uk', 'gb', 'great britain', 'england'],
  'united states': ['us', 'usa'], germany: ['de', 'ger', 'deutschland'],
  france: ['fr', 'fra'], italy: ['it', 'ita'], spain: ['es', 'esp'],
  portugal: ['pt', 'por'], poland: ['pl', 'pol', 'polska'],
  netherlands: ['nl', 'ned', 'holland'], turkey: ['tr', 'tur', 'turkiye'],
  belgium: ['be'], austria: ['at'], switzerland: ['ch'],
  canada: ['ca'], australia: ['au', 'aus'], india: ['in', 'ind'],
  'south africa': ['za'], brazil: ['br', 'bra'], argentina: ['ar', 'arg'],
  arabia: ['mena', 'arabic', 'saudi / mena']
};
const fold = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/\bbackup(?:[\s#_-]*\d+)?\b/gi, ' ')
    .replace(/\.[bB]\s*$/g, ' ')
    .replace(/\b(hd|fhd|uhd|4k|sd|raw|sat|hevc|match time|1080p|720p|50fps|60fps)\b/gi, ' ')
    .replace(/\bsports\b/gi, 'sport') // normalize sports -> sport
    .replace(/\bsuper\s*sport\b/gi, 'supersport')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

class BroadcasterMatchService {
  constructor(opts = {}) {
    let customPath = null;
    try {
      if (opts && typeof opts === 'object' && opts.catalogPath) {
        customPath = opts.catalogPath;
      }
    } catch (_) {}
    const candidates = [
      customPath,
      path.resolve(__dirname, '../data/vavoo_channels.json'),
      path.resolve(__dirname, './data/vavoo_channels.json'),
      path.resolve(__dirname, './src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'src/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'dist/data/vavoo_channels.json'),
      path.resolve(process.cwd(), 'data/vavoo_channels.json')
    ].filter(Boolean);
    this._catalogPath = candidates.find(p => fs.existsSync(p)) || candidates[0];
    this._channelIndex = new Map();
    this._literalIndex = new Map();
    this._literalRegionalIndex = new Map();
    this._aliasTargets = new Map();
    this._regionalIndex = new Map();
    this._countryAliases = new Map();
    for (const [country, aliases] of Object.entries(COUNTRY_ALIASES)) {
      for (const alias of [country, ...aliases]) this._countryAliases.set(alias, country);
    }
    // Provider country codes come from this same metadata (including RO/BG/HR).
    // Keep established aliases such as MENA -> Arabia as the canonical group.
    for (const { name, country } of ChannelCountryService.getRules()) {
      const canonical = this._countryAliases.get(fold(name)) || this._countryAliases.get(fold(country)) || fold(country);
      this._countryAliases.set(fold(name), canonical);
      this._countryAliases.set(fold(country), canonical);
    }
    this._initialized = false;
    this._init();
  }

  _init() {
    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    try {
      const channels = JSON.parse(fs.readFileSync(this._catalogPath, 'utf8'));
      if (!Array.isArray(channels)) return;

      for (const ch of channels) {
        if (ch && typeof ch.group === 'string' && ch.group.trim()) {
          const group = fold(ch.group);
          if (!this._countryAliases.has(group)) this._countryAliases.set(group, group);
        }
      }
      this._countryPattern = new RegExp('\\b(?:' + [...this._countryAliases.keys()]
        .sort((a, b) => b.length - a.length).map(escapeRegex).join('|') + ')\\b', 'g');

      const GROUP_PRIORITY = {
        'United Kingdom': 100,
        'Spain': 90,
        'France': 85,
        'Germany': 80,
        'Portugal': 75,
        'Italy': 70
      };

      for (const ch of channels) {
        if (!ch || !ch.name || !ch.vavooUrl) continue;

        const country = this._countryAliases.get(fold(ch.group));
        const norm = normalizeName(this._countryName(ch.name, country).name);
        const literal = normalizeName(ch.name);
        if (!literal) continue;
        const literalExisting = this._literalIndex.get(literal);
        if (!literalExisting || (GROUP_PRIORITY[ch.group] || 10) > (GROUP_PRIORITY[literalExisting.group] || 10)) {
          this._literalIndex.set(literal, ch);
        }
        if (norm) {
          const existing = this._channelIndex.get(norm);
          const existingScore = existing ? (GROUP_PRIORITY[existing.group] || 10) : 0;
          const currentScore = GROUP_PRIORITY[ch.group] || 10;
          if (!existing || currentScore > existingScore) {
            this._channelIndex.set(norm, ch);
          }
        }

        if (ch.group) {
          if (!this._regionalIndex.has(country)) this._regionalIndex.set(country, new Map());
          const regional = this._regionalIndex.get(country);
          if (norm && !regional.has(norm)) regional.set(norm, ch);
          if (!this._literalRegionalIndex.has(country)) this._literalRegionalIndex.set(country, new Map());
          const regionalLiteral = this._literalRegionalIndex.get(country);
          if (literal && !regionalLiteral.has(literal)) regionalLiteral.set(literal, ch);
        }
      }

      this._registerKnownAliases();
      this._initialized = true;
    } catch (err) {
      console.error('[BroadcasterMatchService] Failed to index Vavoo channels:', err.message);
    }
  }

  _registerKnownAliases() {
    // Common broadcast network naming discrepancies between schedule scrapers and Vavoo
    const ALIAS_MAPPINGS = [
      // UK
      { alias: 'tnt sports 1', target: 'tnt sport 1' },
      { alias: 'tnt sports 2', target: 'tnt sport 2' },
      { alias: 'tnt sports 3', target: 'tnt sport 3' },
      { alias: 'tnt sports 4', target: 'tnt sport 4' },
      { alias: 'bt sport 1', target: 'tnt sport 1' },
      { alias: 'bt sport 2', target: 'tnt sport 2' },
      { alias: 'bt sport 3', target: 'tnt sport 3' },
      { alias: 'bt sport 4', target: 'tnt sport 4' },
      { alias: 'sky sports main event', target: 'sky sport main event' },
      { alias: 'sky sports premier league', target: 'sky sport premier league' },
      { alias: 'sky sports football', target: 'sky sport football' },
      { alias: 'sky sports f1', target: 'sky sport f1' },
      { alias: 'sky sports cricket', target: 'sky sport cricket' },
      { alias: 'sky sports golf', target: 'sky sport golf' },
      { alias: 'sky sports action', target: 'sky sport action' },
      { alias: 'sky sports arena', target: 'sky sport arena' },
      { alias: 'sky sports mix', target: 'sky sport mix' },
      { alias: 'sky sports news', target: 'sky sport news' },
      { alias: 'premier sports 1', target: 'premier sport 1' },
      { alias: 'premier sports 2', target: 'premier sport 2' },
      // Spain
      { alias: 'movistar laliga', target: 'm laliga' },
      { alias: 'movistar la liga', target: 'm laliga' },
      { alias: 'm laliga', target: 'm laliga' },
      { alias: 'movistar liga de campeones', target: 'm liga de campeones' },
      { alias: 'movistar campeones', target: 'm liga de campeones' },
      { alias: 'movistar deportes', target: 'movistar deportes' },
      { alias: 'dazn laliga', target: 'dazn laliga 1' },
      { alias: 'dazn laliga 1', target: 'dazn laliga 1' },
      { alias: 'dazn laliga 2', target: 'dazn laliga 2' },
      // France
      { alias: 'canal sport', target: 'canal sport' },
      { alias: 'canal foot', target: 'canal foot' },
      { alias: 'canal 360', target: 'canal 360' },
      { alias: 'bein sports 1 fr', target: 'bein sport 1' },
      { alias: 'bein sports 2 fr', target: 'bein sport 2' },
      { alias: 'bein sports 3 fr', target: 'bein sport 3' },
      // Portugal
      { alias: 'sport tv 1', target: 'sport tv 1' },
      { alias: 'sport tv 2', target: 'sport tv 2' },
      { alias: 'sport tv 3', target: 'sport tv 3' },
      { alias: 'sport tv 4', target: 'sport tv 4' },
      { alias: 'eleven sports 1', target: 'eleven sport 1' },
      { alias: 'benfica tv', target: 'btv benfica' },
      // Germany
      { alias: 'sky sport bundesliga', target: 'sky sport bundesliga' },
      { alias: 'sky sport premier league de', target: 'sky sport premier league' },
      { alias: 'dazn 1 de', target: 'dazn 1' },
      { alias: 'dazn 2 de', target: 'dazn 2' },
      // Italy
      { alias: 'sky sport uno', target: 'sky sport uno' },
      { alias: 'sky sport calcio', target: 'sky sport calcio' },
      { alias: 'sky sport f1 it', target: 'sky sport f1' },
      // International / Pan-Regional
      { alias: 'espn', target: 'espn' },
      { alias: 'espn 2', target: 'espn 2' },
      { alias: 'supersport 1', target: 'supersport 1' },
      { alias: 'supersport 2', target: 'supersport 2' },
      { alias: 'supersport 3', target: 'supersport 3' },
      { alias: 'supersport premier league', target: 'supersport 1' },
      { alias: 'supersport football', target: 'supersport 2' },
      { alias: 'supersport grandstand', target: 'supersport 1' },
      { alias: 'supersport laliga', target: 'supersport 3' },
      { alias: 'supersport action', target: 'supersport action' },
      { alias: 'supersport golf', target: 'supersport golf' },
      { alias: 'eurosport 1', target: 'eurosport 1' },
      { alias: 'eurosport 2', target: 'eurosport 2' }
    ];

    for (const { alias, target } of ALIAS_MAPPINGS) {
      const normAlias = normalizeName(this._countryName(alias).name);
      const normTarget = normalizeName(this._countryName(target).name);
      this._aliasTargets.set(normAlias, normTarget);
    }
  }

  /**
   * Resolves a raw broadcaster name to an active Vavoo channel.
   * Runs in O(1) via hash table lookups.
   *
   * @param {string} rawChannelName
   * @returns {Object|null}
   */
  _countryName(raw, onlyCountry) {
    const countries = new Set();
    let name = fold(raw);
    if (!this._countryPattern) return { name, countries };
    while (true) {
      if (!onlyCountry && this._literalIndex.has(normalizeName(name))) break;
      const candidates = [];
      // Prefer removing an annotation that exposes a known complete brand,
      // whether the annotation is before or after that brand.
      for (const match of [...name.matchAll(this._countryPattern)].reverse()) {
        const token = match[0], offset = match.index;
        const country = this._countryAliases.get(token);
        if (onlyCountry && country !== onlyCountry) continue;
        // A language word within a brand (Liga DE Campeones) is not a
        // country annotation. Read only leading/trailing country tags.
        if (normalizeName(name.slice(0, offset)) && normalizeName(name.slice(offset + token.length))) continue;
        candidates.push({ country, rest: name.slice(0, offset) + ' ' + name.slice(offset + token.length) });
      }
      const selected = candidates.find(candidate => this._literalIndex.has(normalizeName(candidate.rest))) || candidates[0];
      if (!selected) break;
      countries.add(selected.country);
      name = selected.rest;
    }
    return { name, countries };
  }

  findChannel(rawChannelName, context = {}) {
    if (!rawChannelName || typeof rawChannelName !== 'string') return null;
    const countries = new Set();
    for (const field of ['group', 'country', 'countryCode']) {
      const raw = context && context[field];
      if (!raw) continue;
      const country = this._countryAliases.get(fold(raw));
      if (country) countries.add(country);
      else if (field !== 'group') return null;
    }
    if (countries.size > 1) return null;
    // Known literal catalog brands can contain country-looking tokens (ITV
    // BE, BE SPORTS, BEINSPORT AR 1). Preserve their full channel identity.
    const literal = normalizeName(rawChannelName);
    if (!literal) return null;
    if (this._literalIndex.has(literal)) {
      return countries.size ? this._literalRegionalIndex.get([...countries][0])?.get(literal) || null
        : this._literalIndex.get(literal);
    }
    const parsed = this._countryName(rawChannelName);
    for (const country of countries) parsed.countries.add(country);
    if (parsed.countries.size > 1) return null;
    const norm = normalizeName(parsed.name);
    if (!norm) return null;
    const index = parsed.countries.size
      ? this._regionalIndex.get([...parsed.countries][0]) : this._channelIndex;
    if (!index) return null;
    // Only known aliases and quality/country annotations may refine a name.
    // An arbitrary suffix can identify another numbered or regional signal.
    return index.get(norm) || index.get(this._aliasTargets.get(norm)) || null;
  }

  /**
   * Matches a raw broadcaster channel name to a Vavoo StreamSource entity.
   *
   * @param {string} rawChannelName
   * @returns {Object|null} StreamSource compatible object for MatchEntity.sources
   */
  createVavooSource(rawChannelName, context = {}) {
    const ch = this.findChannel(rawChannelName, context);
    if (!ch) return null;

    return {
      source: 'vavoo',
      id: ch.vavooUrl,
      channelName: ch.name,
      language: ch.language || undefined,
      group: ch.group,
      is4k: ch.is4k || false,
      type: 'channel'
    };
  }

  /**
   * Takes a list of raw broadcaster channel names from a match schedule
   * and returns deduplicated Vavoo stream sources.
   *
   * @param {Array<string>} channelNames
   * @returns {Array<Object>}
   */
  matchBroadcastersToVavooSources(channelNames) {
    if (!Array.isArray(channelNames) || channelNames.length === 0) return [];

    const sources = [];
    const seenUrls = new Set();

    for (const name of channelNames) {
      const src = this.createVavooSource(name);
      if (src && !seenUrls.has(src.id)) {
        seenUrls.add(src.id);
        sources.push(src);
      }
    }

    return sources;
  }
}

module.exports = BroadcasterMatchService;
