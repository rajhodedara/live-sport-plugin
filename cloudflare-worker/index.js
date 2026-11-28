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
import { inflateSync } from 'node:zlib';
import pngUnfilterWasm from './png-unfilter.wasm';

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
// Bytes of fake WebP/RIFF header the Streamed.pk / TikTok CDN prepends to
// .image segments. Everything after it is the real MPEG-TS payload.
const CLOAK_PREFIX_BYTES = 42;

function isPngBytes(u8) {
  return u8.length >= 8 &&
    u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
    u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a;
}

function tryFastStoredDeflate(idat, totalIdat, expectedRawLen, memU8, wasmInstance = null) {
  if (totalIdat < 11) return false;

  let chunkIdx = 0;
  let chunkOff = 0;

  function peekByte() {
    if (chunkIdx >= idat.length) return -1;
    return idat[chunkIdx][chunkOff];
  }

  function readByte() {
    if (chunkIdx >= idat.length) return -1;
    const b = idat[chunkIdx][chunkOff++];
    if (chunkOff >= idat[chunkIdx].length) {
      chunkIdx++;
      chunkOff = 0;
    }
    return b;
  }

  function readUInt16LE() {
    const b0 = readByte();
    const b1 = readByte();
    if (b0 === -1 || b1 === -1) return -1;
    return (b0 | (b1 << 8)) >>> 0;
  }

  const cmf = readByte();
  const flg = readByte();
  if (cmf === -1 || flg === -1) return false;
  if (((cmf << 8) | flg) % 31 !== 0) return false;
  if ((cmf & 0x0f) !== 8) return false;
  if (flg & 0x20) {
    for (let k = 0; k < 4; k++) readByte();
  }

  const firstBlockByte = peekByte();
  if (firstBlockByte === -1) return false;
  // If bits 1-2 != 00, block is Huffman compressed -> fall back to general decoder
  if ((firstBlockByte & 0x06) !== 0) return false;

  let outPos = 0;
  let bfinal = 0;

  while (!bfinal) {
    const hdr = readByte();
    if (hdr === -1) return false;
    bfinal = hdr & 1;
    const btype = (hdr >> 1) & 3;
    if (btype !== 0) {
      // Encountered compressed block in mixed stream -> fallback
      return false;
    }

    const len = readUInt16LE();
    const nlen = readUInt16LE();
    if (len === -1 || nlen === -1) return false;
    if ((len ^ 0xffff) !== nlen) {
      throw new Error(`Corrupted stored block LEN/NLEN mismatch: len=${len}, nlen=${nlen}`);
    }

    if (outPos + len > expectedRawLen) {
      throw new Error(`Stored block inflated bytes (${outPos + len}) exceeded expected ${expectedRawLen}`);
    }

    let bytesToRead = len;
    while (bytesToRead > 0) {
      if (chunkIdx >= idat.length) {
        throw new Error('Truncated stored DEFLATE stream');
      }
      const curChunk = idat[chunkIdx];
      const avail = curChunk.length - chunkOff;
      const toCopy = Math.min(avail, bytesToRead);
      memU8.set(curChunk.subarray(chunkOff, chunkOff + toCopy), outPos);
      outPos += toCopy;
      chunkOff += toCopy;
      bytesToRead -= toCopy;
      if (chunkOff >= curChunk.length) {
        chunkIdx++;
        chunkOff = 0;
      }
    }
  }

  if (outPos !== expectedRawLen) {
    throw new Error(`Stored block inflated size ${outPos} does not match expected ${expectedRawLen}`);
  }

  const a0 = readByte(), a1 = readByte(), a2 = readByte(), a3 = readByte();
  if (a0 === -1 || a1 === -1 || a2 === -1 || a3 === -1) {
    throw new Error('Truncated zlib Adler-32 checksum');
  }
  const streamAdler = (((a0 << 24) | (a1 << 16) | (a2 << 8) | a3) >>> 0);

  let calcAdler;
  if (wasmInstance && typeof wasmInstance.exports?.adler32 === 'function') {
    calcAdler = (wasmInstance.exports.adler32(0, expectedRawLen) >>> 0);
  } else {
    let s1 = 1, s2 = 0;
    for (let i = 0; i < expectedRawLen; i++) {
      s1 = (s1 + memU8[i]) % 65521;
      s2 = (s2 + s1) % 65521;
    }
    calcAdler = (((s2 << 16) | s1) >>> 0);
  }

  if (streamAdler !== calcAdler) {
    throw new Error(`Adler-32 checksum mismatch: stream=0x${streamAdler.toString(16)}, calc=0x${calcAdler.toString(16)}`);
  }

  return true;
}

function inflateIdatInto(idat, totalIdat, expectedRawLen, target) {
  const compressed = new Uint8Array(totalIdat);
  let compressedOffset = 0;
  for (const chunk of idat) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.byteLength;
  }

  let inflated;
  try {
    inflated = inflateSync(compressed, { maxOutputLength: expectedRawLen });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`Inflated size exceeded expected ${expectedRawLen}`);
    }
    throw error;
  }

  if (inflated.byteLength > expectedRawLen) {
    throw new Error(`Inflated size ${inflated.byteLength} exceeded expected ${expectedRawLen}`);
  }
  if (inflated.byteLength !== expectedRawLen) {
    throw new Error(`Inflated size ${inflated.byteLength} does not match expected ${expectedRawLen}`);
  }

  target.set(inflated);
  return inflated.byteLength;
}

async function decodePngToTs(arrayBuf) {
  const va = new Uint8Array(arrayBuf);
  if (!isPngBytes(va)) return va;

  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0, kwLn = -1;
  const idat = [];
  let totalIdat = 0;

  while (pos + 12 <= va.length) {
    const len = ((va[pos] << 24) | (va[pos + 1] << 16) | (va[pos + 2] << 8) | va[pos + 3]) >>> 0;
    const type = String.fromCharCode(va[pos + 4], va[pos + 5], va[pos + 6], va[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > va.length) throw new Error(`Truncated PNG chunk: ${type}`);

    if (type === 'IHDR') {
      width = ((va[dataStart] << 24) | (va[dataStart + 1] << 16) | (va[dataStart + 2] << 8) | va[dataStart + 3]) >>> 0;
      height = ((va[dataStart + 4] << 24) | (va[dataStart + 5] << 16) | (va[dataStart + 6] << 8) | va[dataStart + 7]) >>> 0;
      bitDepth = va[dataStart + 8];
      colorType = va[dataStart + 9];
      interlace = va[dataStart + 12];
    } else if (type === 'kwLn' && len === 4) {
      kwLn = ((va[dataStart] << 24) | (va[dataStart + 1] << 16) | (va[dataStart + 2] << 8) | va[dataStart + 3]) >>> 0;
    } else if (type === 'IDAT') {
      idat.push(va.subarray(dataStart, dataEnd));
      totalIdat += len;
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0) throw new Error('Unsupported PNG layout');
  if (width <= 0 || width > 16384 || height <= 0 || height > 16384) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }

  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!bpp) throw new Error(`Unsupported PNG colorType=${colorType}`);

  const stride = width * bpp;
  const expectedRawLen = height * (stride + 1);
  if (expectedRawLen > 32 * 1024 * 1024) {
    throw new Error(`PNG raw size exceeds 32MB limit: ${expectedRawLen}`);
  }

  // Instantiate WebAssembly with exclusive linear memory per decode
  const instance = pngUnfilterWasm instanceof WebAssembly.Module
    ? new WebAssembly.Instance(pngUnfilterWasm)
    : (await WebAssembly.instantiate(pngUnfilterWasm)).instance;
  const memory = instance.exports.memory;
  const outLen = height * stride;
  const totalNeeded = expectedRawLen + outLen;

  const currentBytes = memory.buffer.byteLength;
  if (totalNeeded > currentBytes) {
    const neededPages = Math.ceil((totalNeeded - currentBytes) / 65536);
    memory.grow(neededPages);
  }

  const rawPtr = 0;
  const outPtr = expectedRawLen;
  const memU8 = new Uint8Array(memory.buffer);

  // Attempt fast stored-block bulk copy path first
  const isStored = tryFastStoredDeflate(idat, totalIdat, expectedRawLen, memU8, instance);

  if (!isStored) {
    inflateIdatInto(idat, totalIdat, expectedRawLen, memU8);
  }

  const retCode = instance.exports.unfilter(rawPtr, outPtr, width, height, bpp);
  if (retCode !== 0) throw new Error(`WASM unfilter failed with code ${retCode}`);

  let payload = memU8.subarray(outPtr, outPtr + outLen);
  if (colorType === 4 || colorType === 6) {
    const keep = colorType === 4 ? 1 : 3;
    const stripped = new Uint8Array(width * height * keep);
    for (let src = 0, dst = 0; dst < stripped.length; src += bpp, dst += keep) {
      for (let k = 0; k < keep; k++) stripped[dst + k] = memU8[outPtr + src + k];
    }
    payload = stripped;
  }

  if (kwLn > 0 && kwLn <= payload.length) {
    payload = payload.subarray(0, kwLn);
  }

  if (payload.length >= 8 && payload[0] === 0x4b && payload[1] === 0x57 && payload[2] === 0x50 && payload[3] === 0x31) {
    const tsLen = ((payload[4] << 24) | (payload[5] << 16) | (payload[6] << 8) | payload[7]) >>> 0;
    if (8 + tsLen > payload.length) throw new Error('KWP1 length exceeds decoded bytes');
    return payload.slice(8, 8 + tsLen);
  }

  if (payload.length >= 188 && payload[0] === 0x47) {
    let aligned = Math.floor(payload.length / 188) * 188;
    while (aligned >= 188 && payload[aligned - 188] !== 0x47) aligned -= 188;
    return aligned > 0 ? payload.slice(0, aligned) : payload.slice();
  }

  throw new Error('Decoded PNG does not contain KWP1 or MPEG-TS payload');
}

async function inflatePngOnly(rawBuf) {
  const va = new Uint8Array(rawBuf);
  if (!isPngBytes(va)) throw new Error('Not a valid PNG signature');

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let totalIdat = 0;

  while (pos + 8 <= va.length) {
    const len = ((va[pos] << 24) | (va[pos + 1] << 16) | (va[pos + 2] << 8) | va[pos + 3]) >>> 0;
    const type = String.fromCharCode(va[pos + 4], va[pos + 5], va[pos + 6], va[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > va.length) throw new Error(`Truncated PNG chunk: ${type}`);

    if (type === 'IHDR') {
      width = ((va[dataStart] << 24) | (va[dataStart + 1] << 16) | (va[dataStart + 2] << 8) | va[dataStart + 3]) >>> 0;
      height = ((va[dataStart + 4] << 24) | (va[dataStart + 5] << 16) | (va[dataStart + 6] << 8) | va[dataStart + 7]) >>> 0;
      bitDepth = va[dataStart + 8];
      colorType = va[dataStart + 9];
      interlace = va[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(va.subarray(dataStart, dataEnd));
      totalIdat += len;
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }

  if (bitDepth !== 8 || interlace !== 0) throw new Error('Unsupported PNG layout');
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!bpp) throw new Error(`Unsupported PNG colorType=${colorType}`);

  const stride = width * bpp;
  const expectedRawLen = height * (stride + 1);

  const instance = pngUnfilterWasm instanceof WebAssembly.Module
    ? new WebAssembly.Instance(pngUnfilterWasm)
    : (await WebAssembly.instantiate(pngUnfilterWasm)).instance;
  const memory = instance.exports.memory;
  if (expectedRawLen > memory.buffer.byteLength) {
    const pages = Math.ceil((expectedRawLen - memory.buffer.byteLength) / 65536);
    memory.grow(pages);
  }
  const targetBuf = new Uint8Array(memory.buffer);

  const isStored = tryFastStoredDeflate(idat, totalIdat, expectedRawLen, targetBuf, instance);
  let inflatedLen = 0;
  if (isStored) {
    inflatedLen = expectedRawLen;
  } else {
    inflatedLen = inflateIdatInto(idat, totalIdat, expectedRawLen, targetBuf);
  }

  return { inflatedBytes: inflatedLen, isStored, width, height, stride };
}

export { decodePngToTs, inflatePngOnly, isPngBytes };

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

    // --- SECURED BENCHMARK ENDPOINTS FOR CANARY MEASUREMENTS ---
    if (action === 'bench_relay' || action === 'bench_inflate' || action === 'bench_decode') {
      const benchToken = request.headers.get('x-bench-token');
      const secret = env?.BENCHMARK_TOKEN || env?.BENCH_SECRET;
      if (!secret || !benchToken || benchToken !== secret) {
        return new Response(JSON.stringify({ error: 'Unauthorized benchmark access' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Benchmark requests must be POST with body payload' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
      if (contentLength > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Payload exceeds 10MB limit' }), {
          status: 413,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      try {
        const rawBuf = await request.arrayBuffer();
        if (rawBuf.byteLength > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'Payload exceeds 10MB limit' }), {
            status: 413,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        if (action === 'bench_relay') {
          return new Response(rawBuf, {
            status: 200,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Access-Control-Allow-Origin': '*',
              'x-bytes-count': String(rawBuf.byteLength)
            }
          });
        }

        if (action === 'bench_inflate') {
          const result = await inflatePngOnly(rawBuf);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'x-inflated-bytes': String(result.inflatedBytes)
            }
          });
        }

        if (action === 'bench_decode') {
          const tsBytes = await decodePngToTs(rawBuf);
          return new Response(tsBytes, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp2t',
              'Access-Control-Allow-Origin': '*',
              'x-ts-bytes': String(tsBytes.byteLength)
            }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }
    
    // Clone headers from the incoming request
    const newHeaders = new Headers(request.headers);
    if (referer) newHeaders.set('Referer', referer);
    if (origin) newHeaders.set('Origin', origin);

    // SCRUB ALL CLIENT-IDENTIFYING AND CLOUDFLARE-INTERNAL HEADERS!
    const scrubHeaders = [
      // VPS IP leak headers
      'x-forwarded-for',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
      'forwarded',
      // Cloudflare Worker fingerprint headers (tells upstream it's a CF Worker)
      'cf-ray',
      'cf-visitor',
      'cf-worker',
      'cf-ew-via',
      'cdn-loop'
    ];
    for (const h of scrubHeaders) {
      newHeaders.delete(h);
    }
    
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
    const isCloakedImage = targetUrl.includes('.image') || /tiktokcdn|byteoversea|ibytedtos|strmd\.st|streamed\.pk|cowedd4855ws/i.test(targetUrl);
    const clientRange = request.headers.get('Range') || request.headers.get('range');
    if (isCloakedImage && clientRange) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(clientRange).trim());
      if (m) {
        const start = Number(m[1]);
        const endPart = m[2] ? String(Number(m[2]) + CLOAK_PREFIX_BYTES) : '';
        newHeaders.set('Range', `bytes=${start + CLOAK_PREFIX_BYTES}-${endPart}`);
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
      const imagexFmt = responseHeaders.get('imagex-fmt') || '';
      const isPngSegment = request.method === 'GET' && !isM3u8 && !targetUrl.includes('.key') && (
        action === 'png_ts' ||
        /\.png(?:\?|$)/i.test(targetUrl) ||
        contentType.includes('image/png') ||
        imagexFmt.toLowerCase().includes('png')
      );

      if (isPngSegment) {
        let pngRes = response;
        if (response.status === 206) {
          const fullHeaders = new Headers(newHeaders);
          fullHeaders.delete('Range');
          fullHeaders.delete('range');
          pngRes = await fetch(targetUrl, { method: 'GET', headers: fullHeaders, redirect: 'follow' });
          if (!pngRes.ok) {
            return new Response(pngRes.body, {
              status: pngRes.status,
              statusText: pngRes.statusText,
              headers: responseHeaders
            });
          }
        }
        const rawBuf = await pngRes.arrayBuffer();
        const rawU8 = new Uint8Array(rawBuf);
        const tsBytes = isPngBytes(rawU8)
          ? await decodePngToTs(rawBuf)
          : (isCloakedImage && rawU8.length > CLOAK_PREFIX_BYTES ? rawU8.subarray(CLOAK_PREFIX_BYTES) : rawU8);

        responseHeaders.set('Content-Type', 'video/mp2t');
        responseHeaders.set('Content-Length', String(tsBytes.byteLength));
        responseHeaders.delete('Content-Range');
        responseHeaders.delete('Accept-Ranges');
        return new Response(tsBytes, {
          status: 200,
          headers: responseHeaders
        });
      }

      if (isCloakedImage) {
        responseHeaders.set('Accept-Ranges', 'bytes');

        // Whether the body still starts at file byte 0 is a property of the
        // RESPONSE, not of the Range header we sent. A CDN that honours the
        // shifted range answers 206 with payload from byte 0 (nothing to
        // strip); one that ignores it answers 200 with the whole file, prefix
        // included. Deriving this from the request alone leaks the 42-byte
        // fake WebP header into the payload and hands the player corrupt TS.
        const bodyStartsAtFileZero = response.status !== 206;

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
        if (bodyStartsAtFileZero) {
          const contentLength = responseHeaders.get('Content-Length');
          if (contentLength) {
            responseHeaders.set('Content-Length', String(Math.max(0, Number(contentLength) - CLOAK_PREFIX_BYTES)));
          }
        }

        // A HEAD probe has no body — piping null would throw and turn a valid
        // cache probe into a 502.
        const body = bodyStartsAtFileZero && response.body ? response.body.pipeThrough(new TransformStream({
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
        })) : response.body;

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
