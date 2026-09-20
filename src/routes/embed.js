/**
 * routes/embed.js - /api/proxy-embed (SSRF-protected embed fetcher)
 *
 * Extracted verbatim from src/index.js during a behaviour-preserving split.
 * Do not edit logic here without re-verifying /watch + route responses.
 */
const express = require('express');
const router = express.Router();

// ─── /api/proxy-embed — CORS-safe embed HTML fetcher (SSRF-protected) ────────
// Fetches the HTML of a sports embed page on behalf of the client browser.
// The browser cannot fetch embedindia.st directly (CORS), but this endpoint
// can. It then returns the raw HTML so client-side JS can run the extractor.
//
// SSRF mitigation: only allowed embed domains are accepted (CG-05 / D-05).

const ALLOWED_EMBED_DOMAINS = new Set([
  'embedindia.st',
  'embedindia.com',
  'embedsport.xyz',
  'embed.st',
  'embedme.top',
  'embedstream.me',
  'embedstream.top',
  'streamtape.com',
  'sportsurge.net',
  'vecloud.net',
  'viprow.me',
  'vipbox.lc',
]);

const PROXY_EMBED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

router.get('/api/proxy-embed', async (req, res) => {
  const rawUrl = req.query.url;
  const referer = req.query.referer || '';

  if (!rawUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let parsed;
  try {
    parsed = new URL(decodeURIComponent(rawUrl));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Invalid URL protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // SSRF protection: reject any domain not in the allowlist
  if (!ALLOWED_EMBED_DOMAINS.has(parsed.hostname)) {
    console.warn(`[proxy-embed] Blocked SSRF attempt for domain: ${parsed.hostname}`);
    return res.status(403).json({ error: `Domain ${parsed.hostname} is not in the allowed embed domain list.` });
  }

  try {
    const headers = {
      'User-Agent': PROXY_EMBED_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };
    if (referer) headers['Referer'] = referer;

    const upstream = await fetch(parsed.toString(), {
      headers,
      signal: AbortSignal.timeout(12000),
      redirect: 'follow'
    });

    const html = await upstream.text();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(html);
  } catch (err) {
    console.error(`[proxy-embed] Fetch failed for ${parsed.hostname}: ${err.message}`);
    res.status(502).json({ error: 'Failed to fetch embed page', detail: err.message });
  }
});



module.exports = router;
