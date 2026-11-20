'use strict';

const BaseProvider = require('./BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');
const { extractTeamsFromTitle } = require('../services/TeamNameExtractor');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class SportsBiteProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'SportsBite';
  }

  async getMatches() {
    const matches = [];
    try {
      const res = await this.proxyFetch('https://sportsbite.org/api/forestgump/matches', {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://sportsbite.org/',
          'Origin': 'https://sportsbite.org',
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      if (!res.ok) return matches;
      const data = typeof res.json === 'function' ? await res.json() : JSON.parse(res.text);
      if (!data || !Array.isArray(data.days)) return matches;

      for (const day of data.days) {
        if (!day || !Array.isArray(day.events)) continue;

        for (const ev of day.events) {
          if (!ev || typeof ev.title !== 'string' || !ev.title.trim()) continue;

          const sources = [];
          if (Array.isArray(ev.streams)) {
            for (const st of ev.streams) {
              if (!st || !st.manifest_url) continue;
              // Invariant: Exclude steganography feeds (e.g. 247-embed, tv, ibyteimg)
              // Only retain clean self-hosted feeds
              if (st.source !== 'selfhost' || !st.manifest_url.includes('/selfhost/embed/')) {
                continue;
              }

              const idMatch = st.manifest_url.match(/\/selfhost\/embed\/([^?#]+)/);
              const streamId = idMatch ? idMatch[1] : (st.id || '');

              sources.push({
                source: 'sportsbite',
                id: streamId,
                channelName: st.name || st.label || ev.title,
                embedUrl: st.manifest_url,
                resolution: st.quality || undefined,
                language: st.language || undefined
              });
            }
          }

          if (sources.length === 0) continue;

          let team1 = null;
          let team2 = null;
          const extracted = extractTeamsFromTitle(ev.title);
          if (extracted) {
            team1 = { name: extracted[0] };
            team2 = { name: extracted[1] };
          }

          const rawDate = ev.start_time || ev.starts_at || day.date;
          let dateStr = '0';
          if (rawDate) {
            const parsedMs = typeof rawDate === 'number' ? (rawDate > 1e11 ? rawDate : rawDate * 1000) : Date.parse(rawDate);
            if (!Number.isNaN(parsedMs)) dateStr = String(parsedMs);
          }

          const evId = ev.id ? String(ev.id).replace(/[^a-zA-Z0-9_-]/g, '') : Math.random().toString(36).slice(2, 10);
          const slug = ev.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');

          matches.push(new MatchEntity({
            id: `sb_${evId}_${slug}`,
            title: ev.title,
            baseTitle: ev.title,
            category: this.normalizeCategory(ev.sport || 'football'),
            date: dateStr,
            status: dateStr !== '0' && Number(dateStr) > Date.now() ? 'upcoming' : 'live',
            team1,
            team2,
            sources
          }));
        }
      }
    } catch (err) {
      // Guarded egress / timeout / offline: log and return empty matches gracefully
    }

    return matches;
  }
}

module.exports = SportsBiteProvider;
