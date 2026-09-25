/**
 * Nuvio Live Sports - Cloudflare Worker Proxy
 * 
 * Instructions:
 * 1. Go to https://dash.cloudflare.com and sign up/log in.
 * 2. Go to "Workers & Pages" -> "Create Application" -> "Create Worker".
 * 3. Name it "nuvio-proxy" (or anything) and deploy.
 * 4. Click "Edit Code", paste this entire script, and click "Deploy".
 * 5. Copy your worker's URL (e.g., https://nuvio-proxy.yourname.workers.dev)
 * 6. Set this URL as the CF_PROXY_URL environment variable in your Nuvio deployment!
 *
 * FIX: cloaked .image segments translate Range requests correctly. The 42-byte
 * fake WebP/RIFF prefix is stripped from the body and Content-Range /
 * Content-Length are corrected for it, so a ranged response is no longer
 * shifted by 42 bytes. Non-2xx upstream responses are returned as-is instead
 * of being rewritten as a playlist, and the upstream x-length debug header is
 * no longer leaked. The body is no longer piped unawaited.
 */

import { connect } from 'cloudflare:sockets';

// Raw HTTPS GET over TLS socket to prevent Cloudflare from injecting
// cf-worker, cf-ray, and cf-connecting-ip headers that trigger 403 on cdnlivetv.
async function rawHttpsGet(urlStr, customHeaders = {}) {
  const u = new URL(urlStr);
  const hostname = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : 443;
  const path = u.pathname + u.search;

  const socket = connect({ hostname, port }, { secureTransport: 'on' });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const reqLines = [
    `GET ${path} HTTP/1.1`,
    `Host: ${hostname}`,
    `Connection: close`,
    `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36`,
    `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8`,
    `Accept-Language: en-US,en;q=0.9`,
  ];
  for (const [k, v] of Object.entries(customHeaders)) {
    reqLines.push(`${k}: ${v}`);
  }
  reqLines.push('', '');

  const encoder = new TextEncoder();
  await writer.write(encoder.encode(reqLines.join('\r\n')));

  const decoder = new TextDecoder();
  let responseText = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    responseText += decoder.decode(value, { stream: true });
  }
  responseText += decoder.decode();

  const headerEnd = responseText.indexOf('\r\n\r\n');
  if (headerEnd === -1) return { status: 500, body: responseText };

  const rawHeaders = responseText.slice(0, headerEnd);
  const body = responseText.slice(headerEnd + 4);
  const statusLine = rawHeaders.split('\r\n')[0];
  const statusCode = parseInt(statusLine.split(' ')[1], 10) || 200;

  return { status: statusCode, body, rawHeaders };
}

// Bytes of fake WebP/RIFF header the Streamed.pk / TikTok CDN prepends to
// .image segments. Everything after it is the real MPEG-TS payload.
const CLOAK_PREFIX_BYTES = 42;

export default {
  async fetch(request, env, ctx) {
    const reqUrl = new URL(request.url);
    
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    const action = reqUrl.searchParams.get('action');
    const referer = reqUrl.searchParams.get('referer');
    const origin = reqUrl.searchParams.get('origin');
    
    // Clone headers from the incoming request
    const newHeaders = new Headers(request.headers);
    if (referer) newHeaders.set('Referer', referer);
    if (origin) newHeaders.set('Origin', origin);
    
    // OVERWRITE User-Agent to ensure scraper and player exactly match for token binding
    newHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
    newHeaders.delete('Host');

    // --- EDGE SCRAPER FOR STREAMSPORTS99 ---
    if (action === 'streamsports99') {
      try {
        const playerUrl = reqUrl.searchParams.get('playerUrl');
        
        // Use clean headers - cdnlivetv.tv blocks requests with extra proxy headers
        const ss99Headers = new Headers();
        ss99Headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
        ss99Headers.set('Referer', 'https://streamsports99.fun/');
        
        const playerRes = await fetch(playerUrl, { headers: ss99Headers });
        const html = await playerRes.text();
        
        // Find the decoder function (contains atob)
        const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{.+?atob/);
        if (!decoderMatch) return new Response("SS99 Error: No decoder function found", { status: 502 });
        
        const decoderName = decoderMatch[1];
        
        // Find the concatenation line: var X = decoderName(A) + decoderName(B) + ...
        const concatRegex = new RegExp('var\\s+([a-zA-Z0-9_]+)\\s*=\\s*' + decoderName + '\\([^;]+;');
        const concatMatch = html.match(concatRegex);
        if (!concatMatch) return new Response("SS99 Error: No concat line found", { status: 502 });
        
        // Extract all variable names passed to the decoder
        const varRegex = new RegExp(decoderName + '\\(([a-zA-Z0-9_]+)\\)', 'g');
        let varMatch;
        const vars = [];
        while ((varMatch = varRegex.exec(concatMatch[0])) !== null) {
          vars.push(varMatch[1]);
        }
        
        // Decode each base64 variable and concatenate
        let m3u8Url = '';
        for (const v of vars) {
          const valMatch = html.match(new RegExp("var\\s+" + v + "\\s*=\\s*'([^']+)'"));
          if (valMatch && valMatch[1]) {
            let b64 = valMatch[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            try { m3u8Url += atob(b64); } catch(e) {}
          }
        }
        
        if (!m3u8Url) return new Response("SS99 Error: Could not decode m3u8 URL", { status: 502 });
        
        reqUrl.searchParams.set('url', m3u8Url);
        // Update referer/origin for the stream fetch
        newHeaders.set('Referer', 'https://streamsports99.fun/');
        newHeaders.set('Origin', 'https://streamsports99.fun');
        // Fall through to normal proxy logic
      } catch (err) {
        return new Response(`SS99 Edge Scrape Error: ${err.message}`, { status: 502 });
      }
    }
    // -----------------------------------

    // --- EDGE SCRAPER FOR CDNLIVE ---
    if (action === 'cdnlive') {
      try {
        const playerUrl = reqUrl.searchParams.get('playerUrl');
        
        // Use raw TLS socket so Cloudflare does NOT inject cf-worker / cf-ray headers
        let html = '';
        try {
          const rawRes = await rawHttpsGet(playerUrl, {
            'Referer': 'https://cdnlivetv.tv/'
          });
          if (rawRes.status === 200) {
            html = rawRes.body;
          }
        } catch (_) {}

        // Fallback to fetch if raw socket fails
        if (!html) {
          const cdnHeaders = new Headers();
          cdnHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
          cdnHeaders.set('Referer', 'https://cdnlivetv.tv/');
          const playerRes = await fetch(playerUrl, { headers: cdnHeaders });
          html = await playerRes.text();
        }
        
        let m3u8Url = '';
        
        // Strategy 1: Look for direct atob concatenation: var X = atob("...") + atob("...");
        const atobConcatRegex = /var\s+[a-zA-Z0-9_]+\s*=\s*(atob\([^;]+;)/;
        const atobConcatMatch = html.match(atobConcatRegex);
        if (atobConcatMatch) {
          const partsRegex = /atob\s*\(\s*["']([^"']+)["']\s*\)/g;
          let pMatch;
          while ((pMatch = partsRegex.exec(atobConcatMatch[1])) !== null) {
            let b64 = pMatch[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            try { m3u8Url += atob(b64); } catch(e) {}
          }
        }
        
        // Strategy 2: Old decoder function
        if (!m3u8Url) {
          const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{[\s\S]*?atob/);
          if (decoderMatch) {
            const decoderName = decoderMatch[1];
            const concatRegex = new RegExp('var\\s+([a-zA-Z0-9_]+)\\s*=\\s*' + decoderName + '\\([^;]+;');
            const concatMatch = html.match(concatRegex);
            if (concatMatch) {
              const varRegex = new RegExp(decoderName + '\\(([a-zA-Z0-9_]+)\\)', 'g');
              let varMatch;
              const vars = [];
              while ((varMatch = varRegex.exec(concatMatch[0])) !== null) {
                vars.push(varMatch[1]);
              }
              for (const v of vars) {
                const valMatch = html.match(new RegExp("var\\s+" + v + "\\s*=\\s*['\"]([^'\"]+)['\"]"));
                if (valMatch && valMatch[1]) {
                  let b64 = valMatch[1].replace(/-/g, '+').replace(/_/g, '/');
                  while (b64.length % 4) b64 += '=';
                  try { m3u8Url += atob(b64); } catch(e) {}
                }
              }
            }
          }
        }

        // Strategy 3: Plain text .m3u8
        if (!m3u8Url) {
          const m3u8Match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
          if (m3u8Match && m3u8Match[1]) {
            m3u8Url = m3u8Match[1];
          }
        }
        
        if (!m3u8Url) return new Response(JSON.stringify({ error: "Could not decode m3u8 URL", m3u8: "" }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }});

        
        return new Response(JSON.stringify({ m3u8: m3u8Url }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: `Edge Scrape Error: ${err.message}`, m3u8: "" }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }});
      }
    }
    // -----------------------------------

    // --- EDGE SCRAPER FOR EMBED DOMAINS (embedindia.st, embed.st, ppv.st etc.) ---
    // Fetches the embed page at the edge and runs all known extraction patterns
    // (ported from EmbedExtractorChain.js) so the scraper IP = the player IP.
    if (action === 'embed') {
      try {
        const embedUrl = reqUrl.searchParams.get('embedUrl');
        if (!embedUrl) return new Response('Embed Error: missing embedUrl param', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });

        const embedReferer = reqUrl.searchParams.get('referer') || (new URL(embedUrl).origin + '/');
        const embedOrigin  = new URL(embedUrl).origin;

        const embedHeaders = new Headers();
        embedHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
        embedHeaders.set('Referer',    embedReferer);
        embedHeaders.set('Accept',     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');

        const embedRes = await fetch(embedUrl, { headers: embedHeaders });
        if (!embedRes.ok) return new Response(`Embed Error: HTTP ${embedRes.status} from embed page`, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
        const html = await embedRes.text();

        // ── Helper: CF Worker uses atob() natively (no Buffer) ──────────────
        function b64decode(s) {
          let b = s.replace(/-/g, '+').replace(/_/g, '/');
          while (b.length % 4) b += '=';
          return atob(b);
        }

        let m3u8Url = null;

        // Pattern A — plain-text .m3u8 URL anywhere in source
        if (!m3u8Url) {
          const mA = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
          if (mA && mA[1] && mA[1].length > 20 && mA[1].length < 2000) m3u8Url = mA[1];
        }

        // Pattern D — JSON player-config keys (file, source, src, url, hls, stream)
        if (!m3u8Url) {
          const jsonKeys = ['source','file','src','url','hls','stream','streamUrl','hlsUrl'];
          for (const key of jsonKeys) {
            const re = new RegExp(`["']${key}["']\\s*:\\s*["'](https?:\\/\\/[^"']+\\.m3u8[^"']*)["']`, 'i');
            const mD = html.match(re);
            if (mD && mD[1]) { m3u8Url = mD[1]; break; }
          }
        }

        // Pattern E — decoder function + concatenated base64 chunks (SS99 / CDNLive style)
        if (!m3u8Url) {
          const decoderMatch = html.match(/function\s+([a-zA-Z0-9_]+)\s*\([a-zA-Z0-9_]+\)\s*\{[\s\S]{0,200}?atob/);
          if (decoderMatch) {
            const decoderName = decoderMatch[1];
            const callRegex = new RegExp(`${decoderName}\\s*\\(\\s*["']([A-Za-z0-9+/=_-]+)["']\\s*\\)`, 'g');
            let parts = [];
            let cm;
            while ((cm = callRegex.exec(html)) !== null) {
              try { parts.push(b64decode(cm[1])); } catch(_) {}
            }
            if (parts.length > 0) {
              const assembled = parts.join('');
              if (assembled.includes('.m3u8')) {
                const mE = assembled.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
                if (mE) m3u8Url = mE[1];
              }
            }
          }
        }

        // Pattern B — atob("literal") inline + var-map atob(varName) forms
        if (!m3u8Url) {
          const atobLit = /atob\s*\(\s*["']([A-Za-z0-9+/=_-]+)["']\s*\)/g;
          let mB;
          while ((mB = atobLit.exec(html)) !== null && !m3u8Url) {
            try {
              const decoded = b64decode(mB[1]);
              if (decoded.includes('.m3u8')) {
                const u = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
                if (u) m3u8Url = u[1];
              } else if (/^https?:\/\//i.test(decoded.trim())) {
                // Could be a partial URL piece — keep scanning
              }
            } catch(_) {}
          }
          // Var-map form: var x = "b64"; ... atob(x)
          if (!m3u8Url) {
            const varMap = {};
            const varDecl = /var\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*["']([A-Za-z0-9+/=_-]{20,})["']/g;
            let vd;
            while ((vd = varDecl.exec(html)) !== null) varMap[vd[1]] = vd[2];
            const varRef = /atob\s*\(\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\)/g;
            let vr;
            while ((vr = varRef.exec(html)) !== null && !m3u8Url) {
              const val = varMap[vr[1]];
              if (val) {
                try {
                  const decoded = b64decode(val);
                  if (decoded.includes('.m3u8')) {
                    const u = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
                    if (u) m3u8Url = u[1];
                  }
                } catch(_) {}
              }
            }
          }
        }

        // Pattern C — XOR numeric array (TimStreams style)
        if (!m3u8Url) {
          const arrMatch = html.match(/var\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*\[(\d+(?:,\s*\d+)+)\]/);
          if (arrMatch) {
            const nums = arrMatch[1].split(',').map(n => parseInt(n.trim(), 10));
            if (nums.length >= 10) {
              const keyNums = [];
              const keyRe = /var\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*=\s*(\d+)/g;
              let km;
              while ((km = keyRe.exec(html)) !== null) {
                keyNums.push(parseInt(km[1], 10));
                if (keyNums.length >= 3) break;
              }
              for (let ki = 0; ki < keyNums.length - 1 && !m3u8Url; ki++) {
                try {
                  const decoded = nums.map(n => String.fromCharCode(((n ^ keyNums[ki]) - keyNums[ki + 1] + 256) % 256)).join('');
                  if (decoded.includes('.m3u8')) {
                    const u = decoded.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
                    if (u) m3u8Url = u[1];
                  }
                } catch(_) {}
              }
            }
          }
        }

        if (!m3u8Url) {
          return new Response(JSON.stringify({ error: 'Embed Edge: no m3u8 found in page', embedUrl }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Extracted! Set url + correct headers, fall through to normal proxy logic
        reqUrl.searchParams.set('url', m3u8Url);
        newHeaders.set('Referer', embedReferer);
        newHeaders.set('Origin',  embedOrigin);

      } catch (err) {
        return new Response(`Embed Edge Scrape Error: ${err.message}`, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
      }
    }
    // -----------------------------------

    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
      return new Response("Nuvio Cloudflare Proxy is running!", { 
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // Cloaked .image segments: the CDN prepends CLOAK_PREFIX_BYTES of fake
    // WebP/RIFF header, so a client asking for file bytes 0-1023 must ask
    // upstream for 42-1065. When we do that the returned body already starts
    // at payload byte 0 and must NOT be stripped again.
    const isCloakedImage = targetUrl.includes('.image');
    const clientRange = request.headers.get('Range') || request.headers.get('range');
    let shiftedRange = false;
    if (isCloakedImage && clientRange) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(clientRange).trim());
      if (m) {
        const start = Number(m[1]);
        const endPart = m[2] ? String(Number(m[2]) + CLOAK_PREFIX_BYTES) : '';
        newHeaders.set('Range', `bytes=${start + CLOAK_PREFIX_BYTES}-${endPart}`);
        shiftedRange = true;
      }
    }
    
    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow'
      });
      
      const responseHeaders = new Headers(response.headers);
      
      // Inject permissive CORS headers
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');

      // Do not leak upstream headers that no longer describe the body we
      // return (x-length is the un-stripped upstream length).
      responseHeaders.delete('x-length');
      
      const contentType = responseHeaders.get('content-type') || '';
      const isM3u8 = contentType.includes('mpegurl') || contentType.includes('x-mpegURL') || targetUrl.includes('.m3u8');

      // A failed upstream must reach the caller with its real status.
      // Rewriting an error body as if it were a playlist produced 403 HTML
      // that callers could not tell apart from a manifest.
      if (!response.ok) {
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }
      
      if (isM3u8 && request.method === 'GET') {
        const text = await response.text();
        const base = new URL(targetUrl);
        
        // Rewrite m3u8 URLs to point back to this worker
        const rewritten = text.split('\n').map(line => {
          const t = line.trim();
          if (!t) return line;
          
          if (t.startsWith('#')) {
            if (!t.includes('URI="')) return line;
            return t.replace(/URI="([^"]+)"/g, (_, uri) => {
              const absUrl = new URL(uri, base).href;
              const q = new URLSearchParams();
              q.set('url', absUrl);
              if (referer) q.set('referer', referer);
              if (origin) q.set('origin', origin);
              return `URI="${reqUrl.origin}/?${q.toString()}"`;
            });
          }
          
          const absUrl = new URL(t, base).href;
          const q = new URLSearchParams();
          q.set('url', absUrl);
          if (referer) q.set('referer', referer);
          if (origin) q.set('origin', origin);
          return `${reqUrl.origin}/?${q.toString()}`;
        }).join('\n');
        
        return new Response(rewritten, {
          status: response.status,
          headers: responseHeaders
        });
      } else if (targetUrl.includes('.key')) {
        responseHeaders.set('Content-Type', 'application/octet-stream');
      } else {
        // Force video/mp2t for chunks
        responseHeaders.set('Content-Type', 'video/mp2t');
      }
      
      // For Streamed.pk / TikTok CDN .image chunks, strip the fake WebP header
      // in flight AND correct the response metadata for the stripped prefix.
      if (isCloakedImage) {
        responseHeaders.set('Accept-Ranges', 'bytes');

        // Upstream answered in file coordinates (which include the +42 shift
        // we applied above); map them back to payload coordinates.
        const contentRange = responseHeaders.get('Content-Range');
        if (contentRange) {
          const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
          if (cr) {
            const start = Math.max(0, Number(cr[1]) - CLOAK_PREFIX_BYTES);
            const end = Math.max(0, Number(cr[2]) - CLOAK_PREFIX_BYTES);
            const total = Math.max(0, Number(cr[3]) - CLOAK_PREFIX_BYTES);
            responseHeaders.set('Content-Range', `bytes ${start}-${end}/${total}`);
          }
        }

        // Only a response that starts at file byte 0 carries the prefix, so
        // only that one is 42 bytes longer than the payload we hand over.
        if (!shiftedRange) {
          const contentLength = responseHeaders.get('Content-Length');
          if (contentLength) {
            responseHeaders.set('Content-Length', String(Math.max(0, Number(contentLength) - CLOAK_PREFIX_BYTES)));
          }
        }

        const body = shiftedRange ? response.body : response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            if (this.skipped === undefined) this.skipped = 0;
            if (this.skipped < CLOAK_PREFIX_BYTES) {
              const needed = CLOAK_PREFIX_BYTES - this.skipped;
              if (chunk.length <= needed) {
                this.skipped += chunk.length;
              } else {
                controller.enqueue(chunk.subarray(needed));
                this.skipped = CLOAK_PREFIX_BYTES;
              }
            } else {
              controller.enqueue(chunk);
            }
          }
        }));

        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }

      // For video chunks (.ts, .js) and everything else, return the stream directly
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders
      });

    } catch (err) {
      return new Response(`Proxy Error: ${err.message}`, { 
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }
  }
};

// Trigger deployment

// Trigger deployment 2

// Trigger deployment 3
// Force deploy CF workers
// Force trigger for proxy 5 deployment
// Fix wrangler prompt
// Trigger proxy 5 deployment
