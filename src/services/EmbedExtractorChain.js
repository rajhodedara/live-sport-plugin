/**
 * EmbedExtractorChain.js
 *
 * A pluggable, priority-ordered chain of extraction patterns for resolving
 * direct HLS/M3U8 URLs from sports embed pages (embedindia.st and similar).
 *
 * Design goals:
 *  - Each extractor is a standalone, independently testable function
 *  - New patterns can be added without changing the provider class
 *  - Extraction failures are silent and non-breaking (return null)
 *  - The chain tries each pattern in order and returns the first successful match
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pattern A — Plain-text M3U8 URL in page source
// Matches:  https://cdn.example.com/live/stream.m3u8?token=...
// Used by:  providers that expose M3U8 directly in HTML/JS without obfuscation
// ─────────────────────────────────────────────────────────────────────────────
function extractPatternA(html) {
  try {
    const m = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
    if (m && m[1]) {
      const url = m[1];
      // Sanity-check: must be a plausible stream URL
      if (url.length > 20 && url.length < 2000) return url;
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern B — Base64 / atob-encoded M3U8 URL in script blocks
// Matches:  atob("aHR0cHM6Ly8...") patterns in inline <script> tags
// Used by:  providers that base64-encode stream URLs to deter naive scrapers
// ─────────────────────────────────────────────────────────────────────────────
function extractPatternB(html) {
  try {
    // Find all atob(...) calls in the page
    const atobRegex = /atob\s*\(\s*["']([A-Za-z0-9+/=_-]+)["']\s*\)/g;
    let match;
    while ((match = atobRegex.exec(html)) !== null) {
      try {
        let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        if (decoded.includes('.m3u8') || decoded.includes('://')) {
          // If decoded string itself contains an M3U8 URL, extract it
          const urlMatch = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
          if (urlMatch) return urlMatch[1];
          // If it's a URL-like string on its own, return it
          if (/^https?:\/\//i.test(decoded.trim())) return decoded.trim();
        }
      } catch (_) {}
    }

    // Variant: var x = "b64string"; ... atob(x) — concatenated variables
    const varAtobRegex = /var\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*["']([A-Za-z0-9+/=_-]{20,})["']/g;
    const varMap = {};
    let varMatch;
    while ((varMatch = varAtobRegex.exec(html)) !== null) {
      varMap[varMatch[1]] = varMatch[2];
    }

    // Look for atob(varName) references
    const varRefRegex = /atob\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g;
    let refMatch;
    while ((refMatch = varRefRegex.exec(html)) !== null) {
      const varName = refMatch[1];
      if (varMap[varName]) {
        try {
          let b64 = varMap[varName].replace(/-/g, '+').replace(/_/g, '/');
          while (b64.length % 4) b64 += '=';
          const decoded = Buffer.from(b64, 'base64').toString('utf-8');
          if (decoded.includes('.m3u8')) {
            const urlMatch = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
            if (urlMatch) return urlMatch[1];
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern C — XOR / numeric array obfuscation (TimStreams-style)
// Matches:  var XXXX=[nums], YYYY=key1, ZZZZ=key2 → char_code ^ key1 - key2 + 256) % 256
// Used by:  TimStreams-class providers that use XOR obfuscation
// ─────────────────────────────────────────────────────────────────────────────
function extractPatternC(html) {
  try {
    // Match: var ARRAY=[...], var KEY1=num, var KEY2=num
    const arrayMatch = html.match(/var\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*\[(\d+(?:,\s*\d+)+)\]/);
    if (!arrayMatch) return null;

    const nums = arrayMatch[1].split(',').map(n => parseInt(n.trim(), 10));
    if (nums.length < 10) return null;

    // Search for keys near the array declaration (within 500 chars before or after)
    const arrayIdx = typeof arrayMatch.index === 'number' ? arrayMatch.index : 0;
    const scopeStart = Math.max(0, arrayIdx - 300);
    const scopeEnd = Math.min(html.length, arrayIdx + arrayMatch[0].length + 600);
    const scopeText = html.slice(scopeStart, scopeEnd);

    // Look for numeric key variables near the array declaration (supports minified ',key=123' or 'var key=123')
    const keyMatches = [];
    const keyRegex = /(?:var\s+|,\s*)[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*(\d+)/g;
    let km;
    while ((km = keyRegex.exec(scopeText)) !== null) {
      keyMatches.push(parseInt(km[1], 10));
      if (keyMatches.length >= 8) break;
    }

    // If no keys found in immediate scope, fallback to scanning full html
    if (keyMatches.length < 2) {
      keyRegex.lastIndex = 0;
      while ((km = keyRegex.exec(html)) !== null) {
        keyMatches.push(parseInt(km[1], 10));
        if (keyMatches.length >= 8) break;
      }
    }

    if (keyMatches.length < 2) return null;

    for (let ki = 0; ki < keyMatches.length; ki++) {
      for (let kj = 0; kj < keyMatches.length; kj++) {
        if (ki === kj) continue;
        const key1 = keyMatches[ki];
        const key2 = keyMatches[kj];
        // Try all arithmetic and precedence variants:
        // 1. (n ^ (key1 - key2))
        // 2. ((n ^ key1) - key2)
        // 3. ((n ^ key1) + key2)
        // 4. ((n - key2) ^ key1)
        const decoders = [
          n => String.fromCharCode((n ^ (key1 - key2) + 256) % 256),
          n => String.fromCharCode((((n ^ key1) - key2 + 256) & 255)),
          n => String.fromCharCode((((n ^ key1) + key2 + 256) & 255)),
          n => String.fromCharCode((((n - key2) ^ key1 + 256) & 255))
        ];
        for (const dec of decoders) {
          try {
            const decoded = nums.map(dec).join('');
            if (decoded.includes('.m3u8')) {
              const urlMatch = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
              if (urlMatch) return urlMatch[1];
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern D — JSON blob containing stream URL
// Matches:  {"source":"https://cdn.example.com/live.m3u8"} or {"file":"..."}
// Used by:  providers that configure their player via an inline JSON object
// ─────────────────────────────────────────────────────────────────────────────
function extractPatternD(html) {
  try {
    const keys = ['source', 'file', 'src', 'url', 'hls', 'stream', 'streamUrl', 'hlsUrl'];
    for (const key of keys) {
      const re = new RegExp(`["']${key}["']\\s*:\\s*["'](https?:\\/\\/[^"']+\\.m3u8[^"']*)["']`, 'i');
      const m = html.match(re);
      if (m && m[1]) return m[1];
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern E — StreamSports99-style: decoder function + concat vars + base64 parts
// Matches:  function decode(x){return atob(x)} var a=decode("..."), b=decode("...")
// Used by:  providers that split and concatenate multiple base64 segments
// ─────────────────────────────────────────────────────────────────────────────
function extractPatternE(html) {
  try {
    // Find a decoder function that uses atob
    const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.{0,200}?atob/s);
    if (!decoderMatch) return null;

    const decoderName = decoderMatch[1];

    // Find all calls to that function and collect the results
    const callRegex = new RegExp(`${decoderName}\\s*\\(\\s*["']([A-Za-z0-9+/=_-]+)["']\\s*\\)`, 'g');
    const parts = [];
    let callMatch;
    while ((callMatch = callRegex.exec(html)) !== null) {
      try {
        let b64 = callMatch[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        parts.push(Buffer.from(b64, 'base64').toString('utf-8'));
      } catch (_) {}
    }

    if (parts.length === 0) return null;

    const assembled = parts.join('');
    if (assembled.includes('.m3u8')) {
      const urlMatch = assembled.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
      if (urlMatch) return urlMatch[1];
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — The chain runner
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTORS = [
  { name: 'PatternA (plain M3U8)',       fn: extractPatternA },
  { name: 'PatternD (JSON player config)', fn: extractPatternD },
  { name: 'PatternE (decoder+concat b64)', fn: extractPatternE },
  { name: 'PatternB (atob / b64 encode)', fn: extractPatternB },
  { name: 'PatternC (XOR numeric array)', fn: extractPatternC },
];

/**
 * Run all extractors in priority order and return the first successful M3U8 URL.
 *
 * @param {string} html  Raw HTML source of the embed page
 * @param {string} [hint] Optional provider hint to influence ordering
 * @returns {{ url: string, pattern: string } | null}
 */
function extract(html, hint = '') {
  if (!html || typeof html !== 'string') return null;

  // If the provider hint suggests XOR obfuscation (e.g. 'timstreams'), try C first
  const ordered = hint.toLowerCase().includes('tim')
    ? [EXTRACTORS[4], ...EXTRACTORS.filter((_, i) => i !== 4)]
    : EXTRACTORS;

  for (const { name, fn } of ordered) {
    try {
      const url = fn(html);
      if (url && typeof url === 'string' && url.startsWith('http')) {
        return { url, pattern: name };
      }
    } catch (_) {}
  }

  return null;
}

module.exports = { extract, extractPatternA, extractPatternB, extractPatternC, extractPatternD, extractPatternE };
