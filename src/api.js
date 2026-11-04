const { request } = require('./services/ProviderOutbound');

const STREAMED_API = 'https://streamed.pk/api';

function normalizeCategory(cat) {
  if (!cat) return 'other';
  if (typeof cat === 'object' && !Array.isArray(cat)) {
    cat = cat.name || cat.title || 'other';
  }
  cat = String(cat).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cat.includes('soccer') || cat.includes('football')) return 'football';
  if (cat.includes('motor') || cat.includes('racing') || cat.includes('cycling') || cat.includes('f1')) return 'motorsport';
  if (cat.includes('americanfootball') || cat.includes('afl') || cat.includes('gridiron') || cat.includes('nfl')) return 'american_football';
  if (cat.includes('fight') || cat.includes('mma') || cat.includes('boxing') || cat.includes('wrestling') || cat.includes('knuckle') || cat.includes('ufc')) return 'mma';
  if (cat.includes('basketball') || cat.includes('nba') || cat.includes('wnba') || cat.includes('euroleague') || cat.includes('eurocup') || cat.includes('fiba')) return 'basketball';
  if (cat.includes('golf')) return 'golf';
  if (cat.includes('rugby')) return 'rugby';
  if (cat.includes('cricket')) return 'cricket';
  if (cat.includes('tennis')) return 'tennis';
  if (cat.includes('hockey')) return 'hockey';
  if (cat.includes('baseball')) return 'baseball';
  if (cat.includes('darts')) return 'darts';
  if (cat.includes('liveshow') || cat.includes('uncategorized')) return 'other';
  return cat;
}

function normalizeStr(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSameEvent(e1, e2) {
  // If categories differ and neither is 'other' or empty, they probably aren't the same
  if (e1.category && e2.category && 
      e1.category !== 'other' && e2.category !== 'other' && 
      e1.category !== e2.category) {
    return false;
  }
  
  // Check if dates are within 24 hours of each other
  const d1 = parseInt(e1.date) || 0;
  const d2 = parseInt(e2.date) || 0;
  if (d1 && d2 && Math.abs(d1 - d2) > 86400000) return false;

  // Exact ID match
  if (e1.id === e2.id) return true;

  // Fuzzy match on title
  const words1 = normalizeStr(e1.title).split(' ').filter(w => w.length > 2);
  const words2 = normalizeStr(e2.title).split(' ').filter(w => w.length > 2);
  
  let matches = 0;
  for (const w of words1) {
    if (words2.includes(w)) matches++;
  }
  
  const similarity = matches / Math.max(words1.length, words2.length, 1);
  return similarity >= 0.4;
}

let cachedMatches = [];
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all active matches from both sources and merge them into unified events
 */
async function getAllMatches() {
  const now = Date.now();
  if (cachedMatches.length > 0 && (now - lastFetchTime) < CACHE_TTL) {
    console.log('[API] Returning cached matches');
    return cachedMatches;
  }

  const unifiedEvents = [];


  // 2. Fetch from Streamed.pk (Secondary/Fallback) and group them
  try {
    const pkRes_req = await request(`${STREAMED_API}/matches/all`, { headersTimeout: 7000, bodyTimeout: 7000 });
    const pkRes = {
      data: await pkRes_req.body.text().then(t => { try { return JSON.parse(t); } catch(e) { return t; } })
    };
    if (Array.isArray(pkRes.data)) {
      pkRes.data.forEach(s => {
        const pkEvent = {
          id: s.id,
          title: s.title,
          category: normalizeCategory(s.category),
          date: s.date,
          popular: s.popular,
          sources: s.sources || [],
          league: '',
          team1: null,
          team2: null,
          thumbnail_url: ''
        };

        // Try to find a matching event in unifiedEvents
        const existingMatch = unifiedEvents.find(e => isSameEvent(e, pkEvent));

        if (existingMatch) {
          // Merge sources
          existingMatch.sources = [...existingMatch.sources, ...pkEvent.sources];
          // Update popularity if needed
          if (pkEvent.popular === '1') existingMatch.popular = '1';
        } else {
          // If no match found, add as a new event
          unifiedEvents.push(pkEvent);
        }
      });
    }
  } catch (error) {
    console.error('[API] Error fetching from Streamed.pk:', error.message);
  }

  // 3. Fetch from BinTV (Third/Fallback) and group them
  try {
    const bintvRes_req = await request('https://prabashsapkota.github.io/bintvjson/index.json', { headersTimeout: 7000, bodyTimeout: 7000 });
    const bintvRes = {
      data: await bintvRes_req.body.text().then(t => { try { return JSON.parse(t); } catch(e) { return t; } })
    };
    if (Array.isArray(bintvRes.data)) {
      bintvRes.data.forEach((s, index) => {
        const title = s.name || s.title || `BinTV Event ${index}`;
        
        // Extract sources from keys like 'url_Sky Sports'
        const bintvSources = [];
        Object.keys(s).forEach(key => {
          if (key.startsWith('url_') && s[key]) {
            const streamName = key.replace('url_', '').trim();
            bintvSources.push({
              source: 'bintv',
              id: streamName,
              url: s[key] // The direct URL, m3u8, or iframe
            });
          }
        });

        if (bintvSources.length === 0) return;

        const binEvent = {
          id: `bintv_${index}_${normalizeStr(title).substring(0, 10)}`,
          title: title,
          category: normalizeCategory(s.category),
          date: Date.now().toString(), // BinTV JSON doesn't provide precise unix timestamps, just 'Live' string
          popular: '0',
          sources: bintvSources,
          league: '',
          team1: null,
          team2: null,
          thumbnail_url: s.logo || ''
        };

        // Try to find a matching event in unifiedEvents
        const existingMatch = unifiedEvents.find(e => isSameEvent(e, binEvent));

        if (existingMatch) {
          existingMatch.sources = [...existingMatch.sources, ...binEvent.sources];
          if (!existingMatch.thumbnail_url && binEvent.thumbnail_url) {
            existingMatch.thumbnail_url = binEvent.thumbnail_url;
          }
        } else {
          unifiedEvents.push(binEvent);
        }
      });
    }
  } catch (error) {
    console.error('[API] Error fetching from BinTV:', error.message);
  }

  // 4. Fetch from Streamed-Images JSON (Additional BinTV Sources)
  try {
    const extraRes_req = await request('https://prabashsapkota.github.io/Streamed-images-json/index.json', { headersTimeout: 7000, bodyTimeout: 7000 });
    const extraRes = {
      data: await extraRes_req.body.text().then(t => { try { return JSON.parse(t); } catch(e) { return t; } })
    };
    if (extraRes.data && Array.isArray(extraRes.data.matches)) {
      extraRes.data.matches.forEach((s, index) => {
        const title = s.title || `Extra Event ${index}`;
        
        if (!Array.isArray(s.url) || s.url.length === 0) return;

        const extraSources = s.url.map(stream => ({
          source: 'bintv',
          id: stream.source || 'Stream',
          url: stream.url
        }));

        const extraEvent = {
          id: `extra_${index}_${normalizeStr(title).substring(0, 10)}`,
          title: title,
          category: 'other', // Often missing in this JSON
          date: Date.now().toString(),
          popular: '0',
          sources: extraSources,
          league: '',
          team1: null,
          team2: null,
          thumbnail_url: s.poster || ''
        };

        // Try to find a matching event in unifiedEvents
        const existingMatch = unifiedEvents.find(e => isSameEvent(e, extraEvent));

        if (existingMatch) {
          existingMatch.sources = [...existingMatch.sources, ...extraEvent.sources];
          if (!existingMatch.thumbnail_url && extraEvent.thumbnail_url) {
            existingMatch.thumbnail_url = extraEvent.thumbnail_url;
          }
        } else {
          unifiedEvents.push(extraEvent);
        }
      });
    }
  } catch (error) {
    console.error('[API] Error fetching from Streamed-Images JSON:', error.message);
  }

  // 5. Fetch from TimStreams (vixnuvew API)
  try {
    const tsRes_req = await request('https://timst.top/api/live-upcoming', { headersTimeout: 7000, bodyTimeout: 7000 });
    const tsRes = {
      data: await tsRes_req.body.text().then(t => { try { return JSON.parse(t); } catch(e) { return t; } })
    };
    if (tsRes.data && Array.isArray(tsRes.data.events)) {
      const genres = tsRes.data.genres || {};
      
      tsRes.data.events.forEach((s, index) => {
        const title = s.name || `TimStreams Event ${index}`;
        
        // Map genre integer to normalized category string
        const genreLabel = genres[String(s.genre)] || 'other';
        const category = normalizeCategory(genreLabel);
        
        // Parse ISO time to unix ms timestamp
        let dateMs = Date.now();
        if (s.time) {
          const parsed = new Date(s.time).getTime();
          if (!isNaN(parsed)) dateMs = parsed;
          }
          
          const now = Date.now();
          const FOUR_HOURS = 4 * 60 * 60 * 1000;
          const isLive = dateMs <= now && dateMs > now - FOUR_HOURS;

          // Filter out vip-only streams and map to sources
        const tsSources = (s.streams || [])
          .filter(st => !st.vip)
          .map(st => ({
            source: 'timstreams',
            id: st.name || 'Stream',
            url: st.url
          }));

        if (tsSources.length === 0) return;

        const tsEvent = {
          id: `ts_${s.url || index}`,
          title: title,
          category: category,
          date: dateMs.toString(),
          popular: (isLive || s.featured) ? '1' : '0',
          sources: tsSources,
          league: '',
          team1: null,
          team2: null,
          thumbnail_url: s.logo || ''
        };

        // Try to find a matching event in unifiedEvents
        const existingMatch = unifiedEvents.find(e => isSameEvent(e, tsEvent));

        if (existingMatch) {
          existingMatch.sources = [...existingMatch.sources, ...tsEvent.sources];
          if (!existingMatch.thumbnail_url && tsEvent.thumbnail_url) {
            existingMatch.thumbnail_url = tsEvent.thumbnail_url;
          }
          if (tsEvent.popular === '1') existingMatch.popular = '1';
        } else {
          unifiedEvents.push(tsEvent);
        }
      });
    }
  } catch (error) {
    console.error('[API] Error fetching from TimStreams:', error.message);
  }

  console.log(`[API] Fetched ${unifiedEvents.length} total events`);
  cachedMatches = unifiedEvents;
  lastFetchTime = Date.now();
  return unifiedEvents;
}

/**
 * Get streams for a specific match ID
 * (Not used by new proxy resolver but kept for backwards compatibility if needed)
 */
async function getMatchStreams(matchId) {
  try {
    const res_req = await request(`${STREAMED_API}/streams/match/${matchId}`, { headersTimeout: 5000, bodyTimeout: 5000 });
    const res = {
      data: await res_req.body.text().then(t => { try { return JSON.parse(t); } catch(e) { return t; } })
    };
    return res.data;
  } catch (error) {
    console.error(`[API] Error fetching streams for ${matchId}:`, error.message);
    return [];
  }
}

module.exports = {
  getAllMatches,
  getMatchStreams
};
