const BaseProvider = require('./BaseProvider');
const StreamEntity = require('../domain/StreamEntity');
const path = require('path');

class EmbedStProvider extends BaseProvider {
  constructor(opts = {}) {
    super(opts);
    this.name = 'EmbedSt';
    this.embedIndiaProvider = opts.embedIndiaProvider;
    this.streamedWasmPool = opts.streamedWasmPool || require('../services/StreamedWasmPool');
  }

  async getMatches() {
    return [];
  }

  async resolveStream(sourceId, matchCategory, matchTitle, src = {}) {
    const streams = [];

    const embedUrl = src.embedUrl || sourceId;
    if (!embedUrl || !embedUrl.startsWith('http')) {
      console.warn(`[${this.name}] Invalid embed URL: ${embedUrl}`);
      return streams;
    }

    let referer = src.referer;
    if (!referer) {
      try {
        referer = new URL(embedUrl).origin + '/';
      } catch (err) {
        referer = 'https://embed.st/';
      }
    }

    let targetEmbedUrl = embedUrl;

    // ─── Tier 0: Iframe redirect detection ───────────────────────────────────
    // Some embed.st pages swap their native stream for an iframe fallback.
    const IFRAME_FALLBACK_DOMAINS = ['embedindia.st', 'embedindia.com', 'embedsport.xyz', 'sportsembed.su'];
    if (streams.length === 0 && !embedUrl.includes('sportsembed.su')) {
      try {
        const { safeFetch } = require('../services/ProviderOutbound');
        const htmlRes = await safeFetch(embedUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
            'Referer': referer,
            'Accept': 'text/html'
          },

          bodyTimeout: 6000,
          headersTimeout: 6000
        });
        const html = await htmlRes.text();

        // Check for rockyembed.st nested wrapper iframe
        const rockyMatch = html.match(/src="([^"]*rockyembed\.st[^"]*)"/i);
        if (rockyMatch) {
          try {
            const rockyUrl = rockyMatch[1];
            const rockyRes = await safeFetch(rockyUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                'Referer': embedUrl
              },
              timeoutMs: 6000
            });
            if (rockyRes.status === 200) {
              const rockyHtml = await rockyRes.text();
              const atobMatch = rockyHtml.match(/atob\((?:'|")([^'"]+)(?:'|")\)/);
              if (atobMatch) {
                const decoded = Buffer.from(atobMatch[1], 'base64').toString('utf8');
                targetEmbedUrl = decoded.split('#')[0].replace(/\/+$/, '');
                console.log(`[${this.name}] Unwrapped rockyembed target -> ${targetEmbedUrl} for ${matchTitle}`);
              }
            }
          } catch (err) {
            console.warn(`[${this.name}] rockyembed unwrap failed: ${err.message}`);
          }
        }

        // Match <iframe src="https://embedindia.st/..."> pattern
        const iframeMatch = html.match(/src="(https:\/\/([^/"]+)[^"]+)"/g);
        if (iframeMatch) {
          for (const attr of iframeMatch) {
            const srcMatch = attr.match(/src="(https?:\/\/[^"]+)"/);
            if (!srcMatch) continue;
            const iframeSrc = srcMatch[1];
            try {
              const iframeHost = new URL(iframeSrc).hostname;
              if (IFRAME_FALLBACK_DOMAINS.includes(iframeHost)) {
                console.log(`[${this.name}] Detected iframe redirect -> ${iframeSrc} for ${matchTitle}. Resolving via iframe provider.`);
                const iframeReferer = new URL(iframeSrc).origin + '/';

                if (iframeSrc.includes('embedindia') && this.embedIndiaProvider) {
                  const indiaStreams = await this.embedIndiaProvider.resolveStream(iframeSrc, matchCategory, matchTitle, { referer: iframeReferer });
                  if (indiaStreams.length > 0) {
                    indiaStreams.forEach(s => {
                      s.name = this.name;
                      s.title = s.title.replace('EmbedIndia', this.name);
                    });
                    streams.push(...indiaStreams);
                    break;
                  }
                }

                streams.push(new StreamEntity({
                  name: 'EmbedSt',
                  title: `${matchTitle} (Live)`,
                  externalUrl: `/watch?mode=extract&embed=${encodeURIComponent(iframeSrc)}&referer=${encodeURIComponent(iframeReferer)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`
                }));
                break;
              }
            } catch (_) {}
          }
        }
      } catch (e) {
        // Non-fatal - if HTML fetch fails just fall through to WASM
        console.warn(`[${this.name}] Iframe detection prefetch failed for ${embedUrl}: ${e.message}`);
      }
    }

    // ─── Tier 1: Worker Thread WASM Decryption (No child_process spawning) ────
    const enableWasm = process.env.ENABLE_WASM !== 'false';
    if (enableWasm && streams.length === 0) {
      try {
        // Parse the user, event, id from targetEmbedUrl: https://embed.st/embed/admin/ppv-celtic-vs-lask-linz/1
        const parts = targetEmbedUrl.split('#')[0].replace(/\/+$/, '').split('/').filter(Boolean);
        const user  = parts[parts.length - 3];
        const event = parts[parts.length - 2];
        const id    = parts[parts.length - 1];

        if (user && event && id && !targetEmbedUrl.includes('sportsembed.su')) {
          console.log(`[${this.name}] Decrypting native WASM via worker pool for ${user}/${event}/${id}...`);

          const m3u8Url = await this.streamedWasmPool.resolveWasmStream(user, event, id, targetEmbedUrl);

          if (m3u8Url) {
            console.log(`[${this.name}] Decrypted M3U8 for ${matchTitle}: ${m3u8Url}`);
            const { BASE_URL } = require('../config');
            const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent(referer)}&origin=${encodeURIComponent(new URL(referer).origin)}`;
            streams.push(new StreamEntity({
              name: 'EmbedSt',
              title: `[Direct] ${matchTitle}`,
              url: proxyUrl,
              behaviorHints: { notWebReady: false },
              resolution: 'HD'
            }));
          } else {
            console.warn(`[${this.name}] Worker WASM pool returned null for ${embedUrl}`);
          }
        } else if (embedUrl.includes('sportsembed.su') || embedUrl.includes('watchfooty.st/embed')) {
          console.log(`[${this.name}] Decrypting native WASM for sportsembed...`);
          try {
            const { extractSportsEmbed } = require('./SportsEmbedExtractor');
            const m3u8Url = await extractSportsEmbed(embedUrl);
            if (m3u8Url) {
              console.log(`[${this.name}] Natively decrypted M3U8 for sportsembed: ${m3u8Url}`);
              const { BASE_URL } = require('../config');
              const proxyUrl = `${BASE_URL}/api/manifest?url=${encodeURIComponent(m3u8Url)}&referer=${encodeURIComponent('https://sportsembed.su/')}&origin=${encodeURIComponent('https://sportsembed.su')}`;
              streams.push(new StreamEntity({
                name: 'EmbedSt',
                title: `[Direct] ${matchTitle}`,
                url: proxyUrl,
                behaviorHints: { notWebReady: false },
                resolution: 'HD'
              }));
            }
          } catch (err) {
            console.warn(`[${this.name}] SportsEmbed Decryptor error: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`[${this.name}] Decryptor error for ${embedUrl}: ${err.message}`);
      }
    }

    // ─── Tier 3: Raw embed fallback — always appended ────────────────────────
    streams.push(new StreamEntity({
      name: 'EmbedSt',
      title: `${matchTitle} (Web Player)`,
      externalUrl: `/watch?url=${encodeURIComponent(targetEmbedUrl || embedUrl)}&title=${encodeURIComponent(matchTitle || 'Live Event')}`,
    }));

    return streams;
  }
}

module.exports = EmbedStProvider;
