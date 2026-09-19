const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class StreamedPkProvider extends BaseProvider {
  constructor(opts) {
    super(opts);
    this.name = 'StreamedPk';
    this.embedStProvider = opts.embedStProvider;
    this.embedIndiaProvider = opts.embedIndiaProvider;
    this.apiUrl = 'https://streamed.pk/api';

    this.fetchMatches = this.circuitBreaker.wrap(`${this.name}_fetchMatches`, async () => {
      const res = await this.proxyFetch(`${this.apiUrl}/matches/all`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchLiveMatches = this.circuitBreaker.wrap(`${this.name}_fetchLiveMatches`, async () => {
      const res = await this.proxyFetch(`${this.apiUrl}/matches/live`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    this.fetchStreams = this.circuitBreaker.wrap(`${this.name}_fetchStreams`, async (source, id) => {
      const url = `${this.apiUrl}/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
      const res = await this.proxyFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const [allData, liveData] = await Promise.all([
        this.fetchMatches.fire().catch(() => []),
        this.fetchLiveMatches.fire().catch(() => [])
      ]);

      // Verify which live matches actually have active stream URLs
      const liveVerifiedIds = new Set();
      const liveVerifiedSourceIds = new Set();
      if (Array.isArray(liveData) && liveData.length > 0) {
        await Promise.all(
          liveData.map(async (m) => {
            const src = (m.sources && m.sources[0]) || { source: 'admin', id: m.id };
            try {
              const streams = await this.fetchStreams.fire(src.source || 'admin', src.id || m.id);
              if (Array.isArray(streams) && streams.length > 0) {
                liveVerifiedIds.add(m.id);
                (m.sources || []).forEach(s => liveVerifiedSourceIds.add(s.id));
              }
            } catch (e) {
              // Stream endpoint error or empty
            }
          })
        );
      }

      if (Array.isArray(allData)) {
        const now = Date.now();
        for (const item of allData) {
          if (!item.id || !item.title) continue;

          const is247Channel = !item.date || Number(item.date) <= 0;
          const isGenuinelyLive = is247Channel || liveVerifiedIds.has(item.id) || (item.sources || []).some(s => liveVerifiedSourceIds.has(s.id));
          const isUpcoming = !is247Channel && item.date && Number(item.date) > now;

          // If it is not a 24/7 channel, not actively live, and not upcoming, it is finished! Skip it.
          if (!is247Channel && !isGenuinelyLive && !isUpcoming) {
            continue;
          }

          const status = is247Channel ? '' : (isGenuinelyLive ? 'live' : 'upcoming');

          // Map sources
          const sources = (item.sources || []).map(s => ({
            source: 'streamedpk',
            id: item.id,
            streamSource: s.source,
            streamId: s.id
          }));

          if (sources.length === 0) {
            sources.push({
              source: 'streamedpk',
              id: item.id
            });
          }

          const posterUrl = item.poster ? new URL(item.poster, 'https://streamed.pk').toString() : '';
          const homeBadge = item.teams && item.teams.home && item.teams.home.badge ? `https://streamed.pk/api/images/proxy/${item.teams.home.badge}` : '';
          const awayBadge = item.teams && item.teams.away && item.teams.away.badge ? `https://streamed.pk/api/images/proxy/${item.teams.away.badge}` : '';

          let finalCategory = this.normalizeCategory(item.category);
          if (is247Channel) {
            const titleLower = item.title.toLowerCase();
            const idLower = item.id.toLowerCase();
            if (titleLower.includes('nfl') || idLower.includes('nfl')) finalCategory = 'american_football';
            else if (titleLower.includes('cricket') || idLower.includes('cricket')) finalCategory = 'cricket';
            else if (titleLower.includes('tennis') || idLower.includes('tennis')) finalCategory = 'tennis';
            else if (titleLower.includes('rally') || titleLower.includes('f1') || titleLower.includes('motor')) finalCategory = 'motorsport';
            else if (titleLower.includes('premier league') || titleLower.includes('champions league') || titleLower.includes('europa league') || titleLower.includes('la liga') || titleLower.includes('serie a') || titleLower.includes('bundesliga') || titleLower.includes('football') || titleLower.includes('soccer')) finalCategory = 'football';
            else if (titleLower.includes('rugby') || titleLower.includes('nrl') || titleLower.includes('super league') || titleLower.includes('six nations') || titleLower.includes('fox league')) finalCategory = 'rugby';
            else finalCategory = 'networks';
          }

          matches.push(new MatchEntity({
            id: `spk_${item.id}`,
            title: item.title,
            category: finalCategory,
            status: status,
            date: is247Channel ? '' : String(item.date || Date.now()),
            popular: is247Channel ? '1' : (item.popular ? '1' : '0'),
            poster: posterUrl,
            logo: homeBadge,
            background: posterUrl,
            team1: item.teams && item.teams.home ? { name: item.teams.home.name, logo: homeBadge || null } : null,
            team2: item.teams && item.teams.away ? { name: item.teams.away.name, logo: awayBadge || null } : null,
            sources: sources
          }));
        }
      }
    } catch (err) {
      console.error(`[${this.name}] Failed to get matches:`, err.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];
    try {
      const streamSource = src.streamSource || 'admin';
      const streamId = src.streamId || sourceId;

      const streamList = await this.fetchStreams.fire(streamSource, streamId);
      if (Array.isArray(streamList)) {
        // Sort streams by viewer count (descending)
        streamList.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));

        // Resolve the stream variants in bounded batches.
        //
        // This used to be a hardcoded 3, chosen for Render's 512MB free tier when
        // each variant spawns a WASM child process. We no longer run on Render, so
        // that ceiling is unnecessarily conservative and serialises the resolve
        // into several sequential rounds (12 variants = 4 rounds at 3/batch).
        // Default is now 5, tunable via STREAMEDPK_CHUNK without a rebuild. The
        // batch is still bounded so a machine with little RAM is not overwhelmed.
        const CHUNK_SIZE = Math.max(1, Number(process.env.STREAMEDPK_CHUNK || 5));
        for (let i = 0; i < streamList.length; i += CHUNK_SIZE) {
          const chunk = streamList.slice(i, i + CHUNK_SIZE);
          
          const resolvePromises = chunk.map(async (streamItem) => {
            if (!streamItem.embedUrl) return [];
            
            const viewersText = streamItem.viewers != null ? `👥 ${streamItem.viewers} Viewers` : '';
            const baseLabel = streamItem.language ? `${matchTitle} (${streamItem.language})` : `${matchTitle} Stream ${streamItem.streamNo || 1}`;
            const label = viewersText ? `${baseLabel} | ${viewersText}` : baseLabel;
            
            if (streamItem.embedUrl.includes('embedindia') && this.embedIndiaProvider) {
              return await this.embedIndiaProvider.resolveStream(
                streamItem.embedUrl,
                matchCategory,
                label,
                { embedUrl: streamItem.embedUrl }
              );
            } else if (this.embedStProvider) {
              return await this.embedStProvider.resolveStream(
                streamItem.embedUrl,
                matchCategory,
                label,
                { embedUrl: streamItem.embedUrl }
              );
            } else {
              return [new StreamEntity({
                name: 'StreamedPk',
                title: `${label} (Web Player)`,
                externalUrl: `/watch?url=${encodeURIComponent(streamItem.embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
              })];
            }
          });

          const results = await Promise.allSettled(resolvePromises);
          for (const result of results) {
            if (result.status === 'fulfilled' && Array.isArray(result.value)) {
              streams.push(...result.value);
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${this.name}] resolveStream failed for ${sourceId}:`, err.message);
    }
    return streams;
  }
}

module.exports = StreamedPkProvider;
