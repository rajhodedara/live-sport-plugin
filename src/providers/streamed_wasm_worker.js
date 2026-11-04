'use strict';

const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// ─── 1. Minimal Browser Global Mocks (Isolated to Worker Thread) ──────────────
class Window {}
class Document {}
global.Window = Window;
global.Document = Document;
Object.setPrototypeOf(global, Window.prototype);
global.window = global;
global.self = global;

let targetOrigin = 'https://embed.st';
let fullEmbedUrl = '';

const locationObj = { 
  hostname: 'embed.st', 
  href: 'https://embed.st/embed/dummy/dummy/1',
  search: '',
  pathname: '/embed/dummy/dummy/1'
};

try {
  Object.defineProperty(global, 'location', {
    value: locationObj,
    configurable: true,
    writable: true
  });
} catch (_) {
  global.location = locationObj;
}

global.document = new Document();
global.document.location = locationObj;

try {
  Object.defineProperty(global, 'crypto', {
    value: require('crypto').webcrypto,
    configurable: true,
    writable: true
  });
} catch (_) {}

try {
  Object.defineProperty(global, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' },
    configurable: true,
    writable: true
  });
} catch (_) {}

global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (b64Encoded) => Buffer.from(b64Encoded, 'base64').toString();

const OriginalRequest = global.Request;
global.Request = function(input, init) {
  if (typeof input === 'string' && input.startsWith('/')) {
    input = targetOrigin + input;
  }
  return new OriginalRequest(input, init);
};

let capturedGoat = null;
const OriginalHeadersGet = global.Headers.prototype.get;
global.Headers.prototype.get = function(name) {
  if (name.toLowerCase() === 'goat') return capturedGoat;
  return OriginalHeadersGet.call(this, name);
};

global.document.createElement = () => ({ id: 'mocked-id' });
global.document.body = { appendChild: () => {} };
global.document.querySelector = () => ({ id: 'mocked-id' });
global.document.getElementById = () => ({ id: 'mocked-id' });
global.P2PEngineHls = { tryRegisterServiceWorker: () => Promise.resolve() };
global.Clappr = { Player: class { constructor() {} } };

let currentResolve = null;

// ─── 2. Intercept WASM Import Callbacks & Extract M3U8 ─────────────────────────
global.WebAssembly.instantiateStreaming = async (resp, importObject) => {
  const r = await resp;
  const buffer = await r.arrayBuffer();
  
  if (importObject['./locked_bg.js']) {
    const bg = importObject['./locked_bg.js'];
    for (const key of Object.keys(bg)) {
      if (typeof bg[key] === 'function') {
        const orig = bg[key];
        bg[key] = function(...args) {
          if (args[1] === 'source' && typeof args[2] === 'string' && args[2].includes('.m3u8')) {
            if (currentResolve) {
              const res = currentResolve;
              currentResolve = null;
              res(args[2]);
            }
            return;
          }
          try { 
            const res = orig.apply(this, args); 
            if (res && typeof res.catch === 'function') {
              return res.catch(() => {});
            }
            return res;
          } catch (e) { 
            // Suppress secondary DOM / player errors inside WASM once stream is dispatched
          }
        };
      }
    }
  }
  return global.WebAssembly.instantiate(buffer, importObject);
};

// ─── 3. In-Memory WASM Caching & TLS-Impersonated Fetch Hook ──────────────────
// The build copies providers flat into dist, while source keeps them in src/providers.
const outboundPath = fs.existsSync(path.join(__dirname, 'services', 'ProviderOutbound.js'))
  ? path.join(__dirname, 'services', 'ProviderOutbound.js')
  : path.join(__dirname, '..', 'services', 'ProviderOutbound.js');
const { fetch: guardedFetch } = require(outboundPath);
let cachedWasmBuffer = null;

global.fetch = async (url, opts) => {
  const urlStr = typeof url === 'string' ? url : (url.url || url.href);
  
  if (urlStr.includes('lock.wasm')) {
    if (!cachedWasmBuffer) {
      const wasmPath = fs.existsSync(path.join(__dirname, 'lock.wasm'))
        ? path.join(__dirname, 'lock.wasm')
        : path.join(process.cwd(), 'lock.wasm');
      cachedWasmBuffer = fs.readFileSync(wasmPath);
    }
    return new Response(cachedWasmBuffer, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
  }
  
  if (urlStr.includes('/fetch')) {
    let reqBody = opts ? opts.body : (url.body ? await url.arrayBuffer() : undefined);
    if (url.arrayBuffer && typeof url.arrayBuffer === 'function' && !reqBody) {
      reqBody = await url.arrayBuffer();
    }
    
    const proxyUrl = targetOrigin + '/fetch';
    const fetchOpts = opts || (url.headers ? url : {});
    const reqHeaders = new Headers(fetchOpts.headers || {});
    reqHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
    reqHeaders.set('Referer', fullEmbedUrl);
    reqHeaders.set('Origin', targetOrigin);
    reqHeaders.set('Content-Type', 'application/octet-stream');
    


    const headersObj = {};
    reqHeaders.forEach((v, k) => { headersObj[k] = v; });

    let response;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        response = await guardedFetch(proxyUrl, {
          method: fetchOpts.method || 'POST', headers: headersObj,
          body: reqBody ? Buffer.from(reqBody) : undefined,
          profile: 'vanilla', attempts: 1, diagnosticOwner: 'wasm'
        });
        break;
      } catch (e) {
        if (e.isFatal || e.code === 'ERR_OUTBOUND_BLOCKED' || attempt === 5) throw e;
        await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }
    
    if (!response || !response.ok) {
      throw new Error(`Proxy fetch failed: ${response ? response.status : 'network error'}`);
    }
    
    const responseBody = await response.arrayBuffer();
    let realGoatHeader = null;
    for (let [k, v] of response.headers.entries()) {
      if (k.toLowerCase() === 'goat') realGoatHeader = v;
    }

    const goatHeader = realGoatHeader || OriginalHeadersGet.call(response.headers, 'goat');
    capturedGoat = goatHeader;
    const newHeaders = new Headers();
    for (let [k, v] of response.headers.entries()) {
      newHeaders.set(k, v);
    }
    
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }
  
  return new Response('Not found', { status: 404 });
};

// ─── 4. Preload & Cache Lock Module ──────────────────────────────────────────
let lockModule = null;
let initPromise = null;

function initLock() {
  if (!initPromise) {
    initPromise = (async () => {
      const lockFilePath = fs.existsSync(path.join(__dirname, 'lock.js'))
        ? path.join(__dirname, 'lock.js')
        : path.join(process.cwd(), 'lock.js');
      const lockPath = require('url').pathToFileURL(lockFilePath).href;
      lockModule = await import(lockPath);
      await lockModule.default();
      return lockModule;
    })();
  }
  return initPromise;
}

async function extractStream(user, event, id, embedUrl) {
  fullEmbedUrl = embedUrl;
  try {
    const u = new URL(embedUrl);
    targetOrigin = u.origin;
    locationObj.href = embedUrl;
    locationObj.pathname = u.pathname;
    locationObj.search = u.search;
  } catch (e) {}

  return new Promise(async (resolve, reject) => {
    currentResolve = resolve;
    const timer = setTimeout(() => {
      if (currentResolve === resolve) {
        currentResolve = null;
        reject(new Error('Timeout waiting for stream'));
      }
    }, 10000);

    try {
      await lockModule.set_stream(user, event, id);
    } catch (e) {
      console.error('[Worker] set_stream error:', e);
    }
  });
}

// ─── 5. Message Handling from Main Thread ─────────────────────────────────────
if (parentPort) {
  let isReady = false;

  initLock()
    .then(() => {
      isReady = true;
      parentPort.postMessage({ type: 'ready' });
    })
    .catch((err) => {
      parentPort.postMessage({ type: 'init_error', error: err.message });
    });

  parentPort.on('message', async (msg) => {
    if (!msg || !msg.jobId) return;
    const { jobId, user, event, id, embedUrl } = msg;

    if (!isReady) {
      try {
        await initLock();
        isReady = true;
      } catch (err) {
        return parentPort.postMessage({ jobId, error: err.message });
      }
    }

    try {
      const m3u8Url = await extractStream(user, event, id, embedUrl);
      parentPort.postMessage({ jobId, m3u8Url });
    } catch (err) {
      parentPort.postMessage({ jobId, error: err.message });
    }
  });
}
