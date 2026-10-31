'use strict';
const { fetchUndici: fetch } = require('../../services/ProviderOutbound');

/**
 * SkTechEmbedExtractor
 *
 * Implements HTML / JS regex extraction reversed from Dalvik class `Ls1/c`:
 * - Clappr player array join unpacker (`Ls1/c.q`):
 *   `player.load({ source: func() })` -> parses array joined by `","|"` and unescapes slashes.
 * - Delimited stream URL and header parser (pipe `|` delimiter).
 * - Dynamic `tokenApi` handler for third-party embeds.
 */
class SkTechEmbedExtractor {
  /**
   * Parses pipe-delimited stream strings used across SK Tech TV:
   * e.g. `https://example.com/live.m3u8|User-Agent=Mozilla/5.0...&Referer=https://ref.com/`
   * or `https://example.com/cenc.mpd|user-agent=...`
   *
   * @param {string} rawString
   * @returns {{ url: string, headers: Object, drmScheme: string|null, drmLicense: string|null }}
   */
  parseDelimited(rawString) {
    if (!rawString || typeof rawString !== 'string') {
      return { url: '', headers: {}, drmScheme: null, drmLicense: null };
    }

    const parts = rawString.split('|');
    const url = parts[0].trim().replace(/\[[a-zA-Z0-9_\-]+\]/g, '');
    const headers = {};
    let drmScheme = null;
    let drmLicense = null;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i].trim();
      // Handle key=value or query string style &k=v
      const subPairs = part.split('&');
      for (const pair of subPairs) {
        if (!pair.includes('=')) continue;
        const eqIdx = pair.indexOf('=');
        const key = pair.slice(0, eqIdx).trim().toLowerCase();
        const val = pair.slice(eqIdx + 1).trim();

        if (key === 'user-agent') {
          headers['User-Agent'] = val;
        } else if (key === 'referer') {
          headers['Referer'] = val;
        } else if (key === 'origin') {
          headers['Origin'] = val;
        } else if (key === 'cookie') {
          headers['Cookie'] = val;
        } else if (key === 'authorization') {
          headers['Authorization'] = val;
        } else if (key === 'accept') {
          headers['Accept'] = val;
        } else if (key === 'cache-control') {
          headers['Cache-Control'] = val;
        } else if (key === 'drmscheme') {
          drmScheme = val.toLowerCase();
        } else if (key === 'drmlicense') {
          drmLicense = val;
        }
      }
    }

    if (!headers['User-Agent']) {
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    }

    return { url, headers, drmScheme, drmLicense };
  }

  /**
   * Unpacks Clappr web players that obfuscate the source via JavaScript array join
   * (Equivalent to `Ls1/c.q` in APK)
   *
   * @param {string} html
   * @returns {string|null} Resolved direct .m3u8 or .mpd stream URL
   */
  extractClapprArrayJoin(html) {
    if (!html || typeof html !== 'string') return null;

    const clapprMatch = html.match(/player\.load\(\{[^}]*source:\s*([a-zA-Z0-9_]+)\(\)/i);
    if (!clapprMatch) return null;

    const funcName = clapprMatch[1];
    const funcRegex = new RegExp(`function\\s+${funcName}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\}`, 'i');
    const funcMatch = html.match(funcRegex);
    if (!funcMatch) return null;

    const body = funcMatch[1];
    const arrayMatch = body.match(/\[([\s\S]*?)\]\.join\(['"](.*?)['"]\)/);
    if (!arrayMatch) return null;

    const rawArray = arrayMatch[1];
    const glue = arrayMatch[2];
    const tokens = rawArray.split(/["'],\s*["']/).map(s => s.replace(/^["']|["']$/g, '').replace(/\\\//g, '/'));
    const resolvedUrl = tokens.join(glue).trim();

    return resolvedUrl.startsWith('http') ? resolvedUrl : null;
  }

  /**
   * Resolves a `tokenApi` configuration payload
   * (Reversed from `Ls1/c.r`)
   *
   * @param {string|Object} tokenApiConfig
   * @returns {Promise<{ url: string, headers: Object }|null>}
   */
  async resolveTokenApi(tokenApiConfig) {
    try {
      const config = typeof tokenApiConfig === 'string'
        ? JSON.parse(tokenApiConfig)
        : tokenApiConfig;

      const targetApi = config.api || config.url || '';
      const requestType = (config.request_type || 'get').toLowerCase();
      const linkKey = config.link_key || 'playback_url';

      if (!targetApi) return null;

      const reqHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://sktech.live/'
      };

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 6000);

      const res = await fetch(targetApi, {
        method: requestType === 'post' ? 'POST' : 'GET',
        headers: reqHeaders,
        signal: ctrl.signal
      });
      clearTimeout(timeout);

      if (!res.ok) return null;
      const text = await res.text();

      // Check if it's JSON containing link_key
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed[linkKey]) {
            return { url: parsed[linkKey], headers: reqHeaders };
          }
        } catch (_) {}
      }

      // Check if it's Clappr HTML
      const clapprUrl = this.extractClapprArrayJoin(text);
      if (clapprUrl) {
        return { url: clapprUrl, headers: reqHeaders };
      }

      // Check for direct .m3u8 regex
      const directM3u8 = text.match(/https?:\/\/[^\s'"<>]+\.m3u8[^\s'"<>]*/i);
      if (directM3u8) {
        return { url: directM3u8[0], headers: reqHeaders };
      }

      return null;
    } catch (_) {
      return null;
    }
  }
}

module.exports = new SkTechEmbedExtractor();
