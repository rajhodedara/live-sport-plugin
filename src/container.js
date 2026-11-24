const ReplayZoneProvider = require('./providers/ReplayZoneProvider');
const { createContainer, asClass, asFunction, asValue, InjectionMode } = require('awilix');

const CacheService = require('./services/CacheService');
const CircuitBreakerService = require('./services/CircuitBreakerService');
const CronService = require('./services/CronService');
const M3U8ParserService = require('./services/M3U8ParserService');
const MatchAggregator = require('./services/MatchAggregator');
const StreamScoringService = require('./services/StreamScoringService');
const TimStreamsProvider = require('./providers/TimStreamsProvider');

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
const { resolverTransport } = require('./services/ResolverTransportRuntime');
const { relations: timingRelations } = require('./services/TimingRuntime');
const StreamedWasmPool = require('./services/StreamedWasmPool');
const IframeDomainRegistry = require('./services/IframeDomainRegistry');
const PpvStProvider = require('./providers/PpvStProvider');
const SoccerFullProvider = require('./providers/SoccerFullProvider');
const SkTechProvider = require('./providers/SkTechProvider');
const BasketballVideoProvider = require('./providers/BasketballVideoProvider');
const NflVideoProvider = require('./providers/NflVideoProvider');
const FullRacesProvider = require('./providers/FullRacesProvider');
const HockeyReplaysProvider = require('./providers/HockeyReplaysProvider');
const MlbLiveProvider = require('./providers/MlbLiveProvider');
const VavooProvider = require('./providers/VavooProvider');
const Ak47LiveProvider = require('./providers/Ak47LiveProvider');
const ScoreZoneProvider = require('./providers/ScoreZoneProvider');
const PitSportProvider = require('./providers/PitSportProvider');
const SportsBiteProvider = require('./providers/SportsBiteProvider');
const SportzXProvider = require('./providers/SportzXProvider');
const RoxieStreamsProvider = require('./providers/RoxieStreamsProvider');
const MovieBoxSportsProvider = require('./providers/MovieBoxSportsProvider');
const MovieBoxTVProvider = require('./providers/MovieBoxTVProvider');
const KafkaProvider = require('./providers/KafkaProvider');
const { TrexCatalogStore } = require('./services/TrexCatalogStore');
const { TrexEventSearch } = require('./services/TrexEventSearch');
const ProviderHealthService = require('./services/ProviderHealthService');
const BroadcasterMatchService = require('./services/BroadcasterMatchService');
const DashToHlsService = require('./services/DashToHlsService');
const HlsQualityProbe = require('./services/HlsQualityProbe');

const container = createContainer({
  injectionMode: InjectionMode.PROXY
});

// Register Core Services
container.register({
  replayzoneProvider: asClass(ReplayZoneProvider).singleton(),
  cacheService: asClass(CacheService).singleton(),
  circuitBreaker: asClass(CircuitBreakerService).singleton(),
  m3u8Parser: asClass(M3U8ParserService).singleton(),
  // Measured quality for single-rendition HLS (TimStreams). Shared so its
  // slug-keyed cache and 4-probe concurrency cap are process-wide.
  // asValue, not asClass: the probe takes constructor options, not injected
  // dependencies (same pattern as streamResolveCache above).
  hlsQualityProbe: asValue(new HlsQualityProbe()),
  cronService: asClass(CronService).singleton(),
  matchAggregator: asClass(MatchAggregator).singleton(),
  streamScorer: asClass(StreamScoringService).singleton(),
  streamResolveCache: asValue(new StreamResolveCache({ timingRelations, sharedResolver: resolverTransport })),
  streamedWasmPool: asValue(StreamedWasmPool),
  dashToHlsService: asClass(DashToHlsService).singleton(),
  providerHealthService: asClass(ProviderHealthService).singleton(),
  teamLogoService: asClass(TeamLogoService).singleton(),
  broadcasterMatchService: asValue(new BroadcasterMatchService()),
  // Self-healing iframe-domain knowledge base (DaddyLive family). Singleton so
  // runtime discoveries accumulate for the process lifetime.
  iframeDomainRegistry: asValue(new IframeDomainRegistry()),
  // Trex catalog coverage: the store opens the SQLite catalog lazily and the
  // event search owns its own cache, so both are safe singletons.
  trexCatalogStore: asFunction(() => new TrexCatalogStore()).singleton(),
  trexEventSearch: asFunction(() => new TrexEventSearch()).singleton()
});

// Build dynamic YAML Providers
const yamlBuilder = new YamlProviderBuilder();
const yamlProviders = yamlBuilder.buildProviders(container, container.resolve('circuitBreaker'));

// Register Providers
container.register({
  timStreamsProvider: asClass(TimStreamsProvider).singleton(),

  cdnLiveProvider: asClass(CdnLiveProvider).singleton(),
  streamSports99Provider: asClass(StreamSports99Provider).singleton(),
  embedIndiaProvider: asClass(EmbedIndiaProvider).singleton(),
  embedStProvider: asClass(EmbedStProvider).singleton(),
  streamedPkProvider: asClass(StreamedPkProvider).singleton(),
  daddyLiveProvider: asClass(DaddyLiveProvider).singleton(),
  liveTvProvider: asClass(LiveTVProvider).singleton(),
  damiTvProvider: asClass(DamiTvProvider).singleton(),
  ppvStProvider: asClass(PpvStProvider).singleton(),
  soccerFullProvider: asClass(SoccerFullProvider).singleton(),
  skTechProvider: asClass(SkTechProvider).singleton(),
  basketballVideoProvider: asClass(BasketballVideoProvider).singleton(),
  nflVideoProvider: asClass(NflVideoProvider).singleton(),
  fullRacesProvider: asClass(FullRacesProvider).singleton(),
  hockeyReplaysProvider: asClass(HockeyReplaysProvider).singleton(),
  mlbLiveProvider: asClass(MlbLiveProvider).singleton(),
  vavooProvider: asClass(VavooProvider).singleton(),
  ak47LiveProvider: asClass(Ak47LiveProvider).singleton(),
  scorezoneProvider: asClass(ScoreZoneProvider).singleton(),
  pitSportProvider: asClass(PitSportProvider).singleton(),
  sportsBiteProvider: asClass(SportsBiteProvider).singleton(),
  sportzxProvider: asClass(SportzXProvider).singleton(),
  roxiestreamsProvider: asClass(RoxieStreamsProvider).singleton(),
  movieboxSportsProvider: asClass(MovieBoxSportsProvider).singleton(),
  movieboxTvProvider: asClass(MovieBoxTVProvider).singleton(),
  kafkaProvider: asClass(KafkaProvider).singleton().inject(() => ({
    catalogStore: container.resolve('trexCatalogStore'),
    eventSearch: container.resolve('trexEventSearch')
  })),
  yamlProviders: asValue(yamlProviders)
});

module.exports = container;
