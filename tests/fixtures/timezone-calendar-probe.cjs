'use strict';

// Pure source-module probe: no container, provider, HTTP server or native addon
// is imported. Run in a fresh process so TZ really changes the host formatter.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const { generateDateSvg } = require(path.join(root, 'src/services/MinimalistPosterService'));

async function probe(day) {
  const now = Date.parse(`${day}T18:00:00Z`);
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const matches = [{
    id: 'calendar-fixture', title: 'Example A vs Example B', category: 'football',
    status: 'finished', date: `${day}T12:00:00Z`,
    sources: [{ source: 'replayzone', name: 'Replay', url: 'https://example.org/replay' }]
  }];
  const cache = { rev: 1, getMatchesReadOnly: () => matches, getMatches: () => matches };
  const posterDates = [];
  const mocks = {
    './container': { resolve(name) {
      if (name === 'cacheService') return cache;
      if (name === 'cronService') return { ensureFresh() {} };
      throw new Error(`Unavailable fixture service: ${name}`);
    } },
    './services/ChannelLogoService': { getChannelLogo: () => null },
    './streams': { prewarmMatch: async () => {} },
    './config': { BASE_URL: 'https://addon.example.org' },
    './services/ImageService': { datePosterUrl(base, date) {
      posterDates.push(date);
      return `${base}/img/date?date=${encodeURIComponent(date)}`;
    } },
    './timezone': require(path.join(root, 'src/timezone')),
    './services/MainstreamRankingService': { getMatchTier: () => 1 },
    './services/TeamNameExtractor': { extractTeamsFromTitle: () => null },
    './services/ReplayFilterService': { filterReplayMatches: rows => rows }
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/catalog.js'), 'utf8'), {
    module: mod, exports: mod.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      throw new Error(`Unmocked catalog import: ${name}`);
    },
    console: { log() {}, warn() {}, error() {} },
    Date: FixtureDate, URL, URLSearchParams, setImmediate, Buffer
  }, { timeout: 1000 });

  const config = { timezone: 'Asia/Tokyo' };
  const dateHub = await mod.exports.handleMeta('series', `nuvio_sport_replay_date_${day}`, config);
  const sportHub = await mod.exports.handleMeta('series', 'nuvio_sport_replay_football', config);
  const catalog = await mod.exports.handleCatalog('series', 'nuvio_sports_replays', {}, config);
  const dateCard = catalog.metas.find(meta => meta.id === `nuvio_sport_replay_date_${day}`);
  const svg = generateDateSvg(day, 1, 'football');
  const svgLabels = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map(match => match[1].replace(/<[^>]+>/g, '').trim());
  return {
    day, releaseInfo: dateHub.meta.releaseInfo,
    released: dateHub.meta.videos[0].released,
    seasonName: sportHub.meta.seasons[0].name,
    description: sportHub.meta.description,
    cardReleaseInfo: dateCard.releaseInfo,
    posterDates, svgLabels
  };
}

Promise.all(['2026-11-01', '2027-01-01', '2026-03-01'].map(probe))
  .then(cases => process.stdout.write(JSON.stringify({
    hostZone: Intl.DateTimeFormat().resolvedOptions().timeZone, cases
  })))
  .catch(error => { console.error(error); process.exitCode = 1; });
