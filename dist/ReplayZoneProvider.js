const undici = require('undici');
const crypto = require('crypto');
const { unpack } = require('./deanEdwardsUnpack');
const { BASE_URL: CONFIG_BASE_URL } = require('../config');

function b64Decode(str) {
    let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const rem = b64.length % 4;
    if (rem !== 0) b64 += '='.repeat(4 - rem);
    return Buffer.from(b64, 'base64');
}

class ReplayZoneProvider {
    constructor() {
        this.sourceName = 'replayzone';
        this.replaysUrl = 'https://replay.adityapangshe.workers.dev/replays.txt';
        this._byseCache = new Map();
    }

    async getMatches() {
        try {
            const { body } = await undici.request(this.replaysUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            const text = await body.text();
            
            const matches = [];
            const blocks = text.split('\n\n').filter(b => b.trim());

            for (const block of blocks) {
                const lines = block.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length < 3) continue;

                if (!lines[0].startsWith('#')) continue;
                const title = lines[0].replace(/^#\s*/, '').trim();

                if (!lines[1].startsWith('~')) continue;
                const metaParts = lines[1].replace(/^~\s*/, '').split('\t');
                const category = (metaParts[0] || 'football').toLowerCase();
                const league = metaParts[1] || '';
                const thumbnail = metaParts[2] || '';
                const dateStr = metaParts[3] || '';

                const sources = [];
                for (let i = 2; i < lines.length; i++) {
                    const parts = lines[i].split('\t');
                    if (parts.length < 3) continue;
                    const label = (parts[0] || '').trim();
                    // Upstream line format: "<label>\t<type>\t<url>", where type is
                    // "iframe" or "hls".
                    const type = (parts[1] || '').trim().toLowerCase();
                    const sourceUrl = (parts[2] || '').trim();
                    if (!/^https?:\/\//i.test(sourceUrl)) continue;
                    sources.push({
                        source: this.sourceName,
                        id: sourceUrl, // URL doubles as the resolveStream key
                        name: label,
                        url: sourceUrl,
                        type: type || 'iframe'
                    });
                }

                if (sources.length > 0) {
                    const idSafe = title.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Buffer.from(dateStr).toString('hex');
                    matches.push({
                        id: `rz_${idSafe}`,
                        title,
                        category,
                        league,
                        date: dateStr, 
                        status: 'finished',
                        thumbnail_url: thumbnail,
                        sources
                    });
                }
            }

            console.log(`[ReplayZone] Extracted ${matches.length} matches`);
            return matches;
        } catch (error) {
            console.error('[ReplayZone] Error fetching matches:', error.message);
            return [];
        }
    }

    async resolveStream(url, category, team, srcObj) {
        let rawName = (srcObj && srcObj.name) ? srcObj.name : '';
        const partName = rawName ? rawName.replace(/\([^)]+\)/g, '').trim() : '';

        // Callers pass the source URL directly, but fall back to the source object
        url = url || (srcObj && srcObj.url) || '';
        if (!url) return [];

        // 1. Direct Byse embed (e.g. bysesukior.com, bysefujedu.com)
        if (this._isByseUrl(url)) {
            const streams = await this.extractByse(url, partName);
            if (streams && streams.length > 0) return streams;
        }

        // 2. ok.ru embed
        if (url.includes('ok.ru')) {
            return await this._resolveOkRu(url, partName);
        }

        // 3. Already a direct playable media URL (m3u8/mp4)
        if (this._isDirectMediaUrl(url)) {
            return [this._buildDirectStream(url, partName)];
        }

        // 4. Soccerfull.net page embed
        if (url.includes('soccerfull.net')) {
            const streams = await this.extractSoccerfull(url, partName);
            if (streams && streams.length > 0) return streams;
        }

        // 5. For dailymotion or others, push as external browser stream
        return [{
            name: 'RZ (External)',
            title: partName ? `${partName} (Browser)` : 'Watch in Browser',
            externalUrl: url
        }];
    }

    /** True when the URL belongs to a Byse video streaming platform */
    _isByseUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return /byse[a-z0-9]*\.[a-z]+/i.test(url);
    }

    /** True when the URL is already a playable media file rather than a page. */
    _isDirectMediaUrl(url) {
        return /\.(m3u8|mp4)(?:[?#]|$)/i.test(url);
    }

    /**
     * Decrypts AES-256-GCM encrypted playback payloads from Byse video platforms.
     */
    _decryptBysePlayback(playback) {
        if (!playback || !playback.payload || !playback.iv || !Array.isArray(playback.key_parts)) {
            return null;
        }
        try {
            const version = parseInt(playback.version, 10);
            let keyParts = playback.key_parts;
            if (!isNaN(version) && version >= 1 && version <= 20) {
                const idx1 = version - 1;
                const idx2 = (31 - version) - 1;
                if (playback.key_parts[idx1] && playback.key_parts[idx2]) {
                    keyParts = [playback.key_parts[idx1], playback.key_parts[idx2]];
                }
            }
            const key = Buffer.concat(keyParts.map(b64Decode));
            if (key.length !== 32) return null;

            const iv = b64Decode(playback.iv);
            const payload = b64Decode(playback.payload);
            if (payload.length < 16) return null;

            const ciphertext = payload.subarray(0, payload.length - 16);
            const authTag = payload.subarray(payload.length - 16);

            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return JSON.parse(decrypted.toString('utf8'));
        } catch (err) {
            console.error('[ReplayZone] Byse decryption failed:', err.message);
            return null;
        }
    }

    /**
     * Formats decrypted Byse sources for direct client CDN playback (0 server bandwidth).
     */
    _formatByseStreams(sources, host, partName = '') {
        const streams = [];
        for (const s of sources) {
            if (!s.url) continue;
            const resLabel = s.label || (s.height ? `${s.height}p` : '1080p');
            const cleanPart = partName.trim();
            const streamTitle = cleanPart ? `${cleanPart} (${resLabel})` : `Stream (${resLabel})`;

            streams.push({
                name: 'ReplayZone',
                title: streamTitle,
                resolution: resLabel,
                url: s.url,
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            'Origin': `https://${host}`,
                            'Referer': `https://${host}/`,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
                        }
                    }
                }
            });
        }
        return streams;
    }

    /**
     * Extracts and decrypts streams directly from Byse video platforms (bysefujedu, bysesukior, etc.).
     */
    async extractByse(embedUrl, partName = '') {
        try {
            const u = new URL(embedUrl);
            const host = u.hostname;
            const pathParts = u.pathname.split('/').filter(Boolean);
            const code = pathParts[pathParts.length - 1];
            if (!code) return [];

            const cacheKey = `${host}:${code}`;
            const cached = this._byseCache.get(cacheKey);
            if (cached && cached.expiresAt > Date.now()) {
                return this._formatByseStreams(cached.sources, host, partName);
            }

            const apiUrl = `https://${host}/api/videos/${code}/`;
            const res = await undici.request(apiUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                    'Referer': `https://${host}/e/${code}`,
                    'Origin': `https://${host}`,
                    'Accept': 'application/json, text/plain, */*'
                }
            });

            if (res.statusCode !== 200) {
                console.warn(`[ReplayZone] Byse API returned HTTP ${res.statusCode} for ${code}`);
                return [];
            }

            const json = await res.body.json();
            if (!json || !json.playback) {
                console.warn(`[ReplayZone] No playback block in Byse response for ${code}`);
                return [];
            }

            const decrypted = this._decryptBysePlayback(json.playback);
            if (!decrypted) return [];

            const sources = Array.isArray(decrypted.sources) ? decrypted.sources : [];
            if (sources.length > 0) {
                let expiresAt = Date.now() + 10 * 60 * 1000;
                if (decrypted.expires_at) {
                    const exp = new Date(decrypted.expires_at).getTime();
                    if (!isNaN(exp) && exp > Date.now()) {
                        expiresAt = Math.min(expiresAt, exp);
                    }
                }
                if (this._byseCache.size >= 500) {
                    this._byseCache.delete(this._byseCache.keys().next().value);
                }
                this._byseCache.set(cacheKey, { sources, expiresAt });

                return this._formatByseStreams(sources, host, partName);
            }
        } catch (error) {
            console.error(`[ReplayZone] Error extracting Byse stream (${embedUrl}):`, error.message);
        }
        return [];
    }

    /**
     * Resolves ok.ru videos with parallel-range fastmp4 proxy.
     */
    async _resolveOkRu(url, partName = '') {
        const streams = [];
        try {
            const { body } = await undici.request(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                    'Referer': 'https://ok.ru/',
                    'Origin': 'https://ok.ru',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            });
            
            const html = await body.text();
            
            let videos = [];
            const optionsMatch = html.match(/data-options="([^"]+)"/);
            if (optionsMatch) {
                try {
                    const optionsStr = optionsMatch[1].replace(/&quot;/g, '"');
                    const options = JSON.parse(optionsStr);
                    if (options.flashvars && options.flashvars.metadata) {
                        const meta = typeof options.flashvars.metadata === 'string' ? JSON.parse(options.flashvars.metadata) : options.flashvars.metadata;
                        if (meta.videos) {
                            videos = meta.videos;
                        }
                    }
                } catch(err) {
                    console.error('[ReplayZone] Failed parsing data-options:', err.message);
                }
            }

            if (videos.length > 0) {
                const qMap = {
                    mobile: '144p',
                    lowest: '240p',
                    low: '360p',
                    sd: '480p',
                    hd: '720p',
                    full: '1080p',
                    quad: '1440p',
                    ultra: '4k'
                };
                
                const allowedQualities = ['hd', 'full', 'quad', 'ultra'];
                let filteredVideos = videos.filter(v => allowedQualities.includes(v.name));
                
                // Fallback: if match only has SD, serve best available to avoid 0 streams
                if (filteredVideos.length === 0) {
                    filteredVideos = [videos[videos.length - 1]];
                }

                for (const v of filteredVideos) {
                    if (!v.url) continue;
                    const qName = qMap[v.name] || v.name;
                    // ok.ru CDN: srcIp in token is routing metadata only, NOT enforced.
                    // Confirmed by live cross-IP test (mobile data, different IP → 206 OK).
                    // Players fetch directly from okcdn.ru using proxyHeaders. Server bandwidth: 0.
                    streams.push({
                        name: 'ReplayZone',
                        title: partName.trim() ? `${partName.trim()} (${qName})` : `Stream (${qName})`,
                        resolution: qName,
                        url: v.url,
                        behaviorHints: {
                            notWebReady: true,
                            proxyHeaders: {
                                request: {
                                    'Referer': 'https://ok.ru/',
                                    'Origin': 'https://ok.ru',
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
                                }
                            }
                        }
                    });
                }
            }
        } catch (error) {
            console.error('[ReplayZone] Error fetching ok.ru:', error.message);
        }
        return streams;
    }

    /**
     * Resolves direct media files (e.g. videas.fr or direct m3u8) with client proxyHeaders.
     */
    _buildDirectStream(streamUrl, partName = '', origin = '', referer = '') {
        const cleanPart = partName.trim();
        const stream = {
            name: 'ReplayZone',
            title: cleanPart ? `${cleanPart} (Direct)` : 'Stream (Direct)',
            resolution: 'HD',
            url: streamUrl,
            behaviorHints: {
                notWebReady: true
            }
        };
        if (origin || referer) {
            stream.behaviorHints.proxyHeaders = {
                request: {
                    ...(origin ? { 'Origin': origin } : {}),
                    ...(referer ? { 'Referer': referer } : {}),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
                }
            };
        }
        return stream;
    }

    /** Builds the internal-proxy stream entry used for legacy hanerix-family sources. */
    _buildProxiedStream(streamUrl, partName) {
        const BASE_URL = CONFIG_BASE_URL || 'http://127.0.0.1:7000';
        const referer = 'https://hanerix.com/';
        const origin = 'https://hanerix.com';
        const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(origin)}&proxyChunks=1`;
        return {
            name: 'ReplayZone',
            title: partName.trim() || 'Stream',
            url: proxyUrl,
            behaviorHints: {
                notWebReady: false
            }
        };
    }

    /**
     * Extracts streams from soccerfull.net pages (modern Byse iframes, direct media, or legacy ArtPlayer).
     */
    async extractSoccerfull(url, partName = '') {
        try {
            const res = await undici.request(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
                }
            });
            if (res.statusCode !== 200) return [];
            const html = await res.body.text();

            // Case 1: Search for iframes (Byse embeds, ok.ru, etc.)
            const iframeRegex = /<iframe[^>]+src="([^">]+)"/gi;
            const iframes = [];
            let m;
            while ((m = iframeRegex.exec(html)) !== null) {
                iframes.push(m[1]);
            }

            const streams = [];
            for (const iframeSrc of iframes) {
                let fullIframeUrl;
                try {
                    fullIframeUrl = new URL(iframeSrc, url).toString();
                } catch (e) {
                    continue;
                }

                if (this._isByseUrl(fullIframeUrl)) {
                    const byseStreams = await this.extractByse(fullIframeUrl, partName);
                    if (byseStreams && byseStreams.length > 0) {
                        streams.push(...byseStreams);
                    }
                } else if (fullIframeUrl.includes('ok.ru')) {
                    const okStreams = await this._resolveOkRu(fullIframeUrl, partName);
                    if (okStreams && okStreams.length > 0) {
                        streams.push(...okStreams);
                    }
                } else if (this._isDirectMediaUrl(fullIframeUrl)) {
                    streams.push(this._buildDirectStream(fullIframeUrl, partName));
                }
            }

            if (streams.length > 0) {
                return streams;
            }

            // Case 2: Direct Artplayer embed (videas.fr etc)
            const m3u8VarMatch = html.match(/var\s+m3u8Url\s*=\s*["']([^"']+)["']/i);
            if (m3u8VarMatch) {
                const directUrl = new URL(m3u8VarMatch[1], url).toString();
                return [this._buildDirectStream(directUrl, partName)];
            }

            // Case 3: Legacy hgcloud / hanerix embed
            for (const iframeSrc of iframes) {
                let iframeUrl = new URL(iframeSrc, url).toString();
                if (iframeUrl.includes('hgcloud.to')) {
                    iframeUrl = iframeUrl.replace('hgcloud.to', 'hanerix.com');
                }
                if (iframeUrl.includes('hanerix.com')) {
                    const legacyStream = await this._extractHanerix(iframeUrl, url);
                    if (legacyStream) {
                        streams.push(this._buildDirectStream(legacyStream, partName, 'https://hanerix.com', 'https://hanerix.com/'));
                    }
                }
            }

            return streams;
        } catch (error) {
            console.error('[ReplayZone] Error extracting soccerfull:', error.message);
            return [];
        }
    }

    async _extractHanerix(iframeUrl, pageUrl) {
        try {
            const iframeRes = await undici.request(iframeUrl, {
                headers: {
                    'Referer': new URL(pageUrl).origin + '/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
                }
            });
            const iframeHtml = await iframeRes.body.text();
            
            if (iframeHtml.includes('sandbox not allowed') || iframeHtml.includes('Access denied')) {
                return null;
            }

            const start = iframeHtml.indexOf('eval(function(p,a,c,k,e,d)');
            if (start === -1) return null;

            const end = iframeHtml.indexOf('</script>', start);
            if (end === -1) return null;
            const packed = iframeHtml.substring(start, end).trim();

            const unpacked = unpack(packed);
            if (!unpacked) return null;

            const fileMatch = unpacked.match(/file\s*:\s*["']([^"']+)["']/);
            const direct = fileMatch && fileMatch[1].trim().startsWith('http') ? fileMatch[1].trim() : null;
            const embedded = unpacked.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/);
            const resolved = direct || (embedded && embedded[0]);

            if (resolved) {
                return new URL(resolved, iframeUrl).toString();
            }
            return null;
        } catch (e) {
            return null;
        }
    }
}

module.exports = ReplayZoneProvider;
