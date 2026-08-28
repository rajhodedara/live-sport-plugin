class MatchAggregator {
  constructor({ streamFreeProvider, timStreamsProvider, ntvProvider, iptvOrgProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, strims24Provider, beinArabicProvider, streamedPkProvider, cacheService, yamlProviders }) {
    this.providers = [streamFreeProvider, timStreamsProvider, ntvProvider, iptvOrgProvider, sportyHunterProvider, watchFootyProvider, cdnLiveProvider, streamSports99Provider, streamicProvider, strims24Provider, beinArabicProvider, streamedPkProvider, ...(yamlProviders || [])];
    this.cacheService = cacheService;
  }

  isSameEvent(e1, e2) {
    if (e1.category && e2.category && e1.category !== 'other' && e2.category !== 'other' && e1.category !== e2.category) {
      return false;
    }
    if (e1.id && e1.id === e2.id) return true;
    if (e1.id && e2.id && (e1.id.startsWith('bein_ar') || e2.id.startsWith('bein_ar'))) return false;
    const d1 = Number(e1.date) || 0;
    const d2 = Number(e2.date) || 0;
    if (d1 && d2 && Math.abs(d1 - d2) > 86400000) return false;

    const words1 = new Set(e1.title.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(' ').filter(w => w.length > 2));
    const words2 = new Set(e2.title.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(' ').filter(w => w.length > 2));

    let common = 0;
    for (const w of words1) {
      if (words2.has(w)) common++;
    }
    const jaccard = common / Math.max(words1.size + words2.size - common, 1);
    return jaccard >= 0.5;
  }

  async syncMatches() {
    console.log('[MatchAggregator] Fetching from all providers...');
    const finalMatches = [];

    const processProviderMatches = (providerMatches) => {
      if (!providerMatches || !Array.isArray(providerMatches)) return;
      providerMatches.forEach(match => {
        if (!match.id || !match.title) return;
        
        const existing = finalMatches.find(m => this.isSameEvent(m, match));
        if (!existing) {
          finalMatches.push(match);
        } else {
          if (match.sources && Array.isArray(match.sources)) {
            match.sources.forEach(src => {
              if (!existing.sources.find(s => s.id === src.id && s.source === src.source)) {
                existing.sources.push(src);
              }
            });
          }
          if (match.popular === '1') existing.popular = '1';
          if (!existing.poster && match.poster) existing.poster = match.poster;
          if (existing.description === 'No description' && match.description && match.description !== 'No description') {
            existing.description = match.description;
          }
          if (!existing.logo && match.logo) existing.logo = match.logo;
        }
      });
    };

    // Providers swallow their own errors and return []. A non-empty result is the
    // only reliable success signal; it keeps a total upstream outage from wiping the cache.
    let anyProviderSucceeded = false;

    if (process.env.LOW_MEMORY_MODE === 'true') {
      // Memory-safe sequential fetching (Alwaysdata)
      for (const p of this.providers) {
        try {
          const providerMatches = await p.getMatches();
          if (Array.isArray(providerMatches) && providerMatches.length > 0) anyProviderSucceeded = true;
          processProviderMatches(providerMatches);
        } catch (err) {
          console.error(`[MatchAggregator] Provider fetch failed:`, err.message);
        }
      }
    } else {
      // Fast parallel fetching (Render / Local)
      const results = await Promise.allSettled(this.providers.map(p => p.getMatches()));
      results.forEach((promiseResult, index) => {
        if (promiseResult.status === 'fulfilled') {
          if (Array.isArray(promiseResult.value) && promiseResult.value.length > 0) anyProviderSucceeded = true;
          processProviderMatches(promiseResult.value);
        } else {
          console.error(`[MatchAggregator] Provider ${index} failed:`, promiseResult.reason);
        }
      });
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
      // Live badge should only appear from 10 minutes before kickoff through 3 hours after kickoff.
      const isLiveDisplayWindow = kickoff === 0 || (now >= kickoff - (10 * 60 * 1000) && now <= kickoff + (3 * 60 * 60 * 1000));
      
      // For any scheduled match currently within the live display window, boost the popularity flag.
      // This keeps live MLB/NBA/NFL/etc. games visible even when they do not match a trending keyword.
      if (kickoff > 0 && isLiveDisplayWindow) {
        match.popular = '1';
      } else if (kickoff > 0 && !isLiveDisplayWindow) {
        match.popular = '0';
      }
      
      // Keep the historical keyword boost for known high-interest matches when they are in range.
      if (kickoff === 0 && TRENDING_KEYWORDS.some(kw => titleLower.includes(kw))) {
        match.popular = '1';
      }
    });

    // Filter out matches that are already over (kickoff was > 24 hours ago)
    const activeMatches = finalMatches.filter(match => {
      let kickoff = 0;
      if (match.date) {
        const parsed = Number(match.date);
        kickoff = isNaN(parsed) ? new Date(match.date).getTime() : parsed;
        if (isNaN(kickoff)) kickoff = 0;
      }
      if (kickoff === 0) return true; // Keep if we don't know the time

      // Keep matches up to 24 hours after kickoff, except TimStreams which we keep for 48 hours (VODs)
      const isTimStreams = match.sources && match.sources.some(s => s.source === 'timstreams');
      const expiryWindowMs = isTimStreams ? (48 * 3600 * 1000) : (24 * 3600 * 1000);
      return now <= kickoff + expiryWindowMs;
    });

    console.log(`[MatchAggregator] Sync complete. Merged ${activeMatches.length} active events.`);
    if (anyProviderSucceeded) {
      this.cacheService.setMatches(activeMatches);
    }
    return activeMatches;
  }
}

module.exports = MatchAggregator;
