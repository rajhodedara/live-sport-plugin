const ReplayZoneProvider = require('./providers/ReplayZoneProvider');
const { createContainer, asClass, asValue, InjectionMode } = require('awilix');

const CacheService = require('./services/CacheService');
const CircuitBreakerService = require('./services/CircuitBreakerService');
const CronService = require('./services/CronService');
const M3U8ParserService = require('./services/M3U8ParserService');
const MatchAggregator = require('./services/MatchAggregator');
const StreamScoringService = require('./services/StreamScoringService');
const TimStreamsProvider = require('./providers/TimStreamsProvider');

const WatchFootyProvider = require('./providers/WatchFootyProvider');
const CdnLiveProvider = require('./providers/CdnLiveProvider');
const StreamSports99Provider = require('./providers/StreamSports99Provider');
const EmbedIndiaProvider = require('./providers/EmbedIndiaProvider');
const EmbedStProvider = require('./providers/EmbedStProvider');
const StreamedPkProvider = require('./providers/StreamedPkProvider');
const DaddyLiveProvider = require('./providers/DaddyLiveProvider');
const LiveTVProvider = require('./providers/LiveTVProvider');
const DamiTvProvider = require('./providers/DamiTvProvider');

const TeamLogoService = require('./services/TeamLogoService');
const YamlProviderBuilder = require('./services/YamlProviderBuilder');
const StreamResolveCache = require('./services/StreamResolveCache');
const IframeDomainRegistry = require('./services/IframeDomainRegistry');
const PpvStProvider = require('./providers/PpvStProvider');

const container = createContainer({
  injectionMode: InjectionMode.PROXY
});

// Register Core Services
container.register({
  replayzoneProvider: asClass(ReplayZoneProvider).singleton(),
    cacheService: asClass(CacheService).singleton(),
  circuitBreaker: asClass(CircuitBreakerService).singleton(),
  m3u8Parser: asClass(M3U8ParserService).singleton(),
  cronService: asClass(CronService).singleton(),
  matchAggregator: asClass(MatchAggregator).singleton(),
  streamScorer: asClass(StreamScoringService).singleton(),
  streamResolveCache: asValue(new StreamResolveCache()),
  teamLogoService: asClass(TeamLogoService).singleton(),
  // Self-healing iframe-domain knowledge base (DaddyLive family). Singleton so
  // runtime discoveries accumulate for the process lifetime.
  iframeDomainRegistry: asValue(new IframeDomainRegistry())
});

// Build dynamic YAML Providers
const yamlBuilder = new YamlProviderBuilder();
const yamlProviders = yamlBuilder.buildProviders(container, container.resolve('circuitBreaker'));

// Register Providers
container.register({
  timStreamsProvider: asClass(TimStreamsProvider).singleton(),

  watchFootyProvider: asClass(WatchFootyProvider).singleton(),
  cdnLiveProvider: asClass(CdnLiveProvider).singleton(),
  streamSports99Provider: asClass(StreamSports99Provider).singleton(),
  embedIndiaProvider: asClass(EmbedIndiaProvider).singleton(),
  embedStProvider: asClass(EmbedStProvider).singleton(),
  streamedPkProvider: asClass(StreamedPkProvider).singleton(),
  daddyLiveProvider: asClass(DaddyLiveProvider).singleton(),
  liveTvProvider: asClass(LiveTVProvider).singleton(),
  damiTvProvider: asClass(DamiTvProvider).singleton(),
  ppvStProvider: asClass(PpvStProvider).singleton(),
  yamlProviders: asValue(yamlProviders)
});

module.exports = container;
