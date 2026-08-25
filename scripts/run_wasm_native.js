const fs = require('fs');
const path = require('path');

class Window {}
class Document {}
global.Window = Window;
global.Document = Document;
Object.setPrototypeOf(global, Window.prototype);

global.window = global;
global.self = global;
const fullEmbedUrl = process.argv[5];
let targetOrigin = 'https://embed.st';
let searchParams = '';
let pathName = '/embed/admin/dummy/1';
if (fullEmbedUrl) {
    try {
        const u = new URL(fullEmbedUrl);
        targetOrigin = u.origin;
        searchParams = u.search;
        pathName = u.pathname;
    } catch(e) {}
}

global.location = { 
  hostname: 'embed.st', 
  href: fullEmbedUrl || 'https://embed.st/embed/dummy/dummy/1',
  search: searchParams,
  pathname: pathName
};
global.document = new Document();
global.document.location = global.location;
global.crypto = require('crypto').webcrypto;
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
global.navigator = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' };

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
             console.log(args[2]); // OUTPUT THE URL!
             process.exit(0);
          }
          try { 
            const res = orig.apply(this, args); 
            if (res && typeof res.catch === 'function') {
                return res.catch(e => {
                    console.error("[WASM PROMISE THROW in bg[" + key + "]]", e);
                    throw e;
                });
            }
            return res;
          } catch(e) { 
            console.error("[WASM THROW in imported function bg[" + key + "]]", e);
            throw e; 
          }
        };
      }
    }
  }
  return global.WebAssembly.instantiate(buffer, importObject);
};

const originalFetch = global.fetch;

global.fetch = async (url, opts) => {
  const urlStr = typeof url === 'string' ? url : (url.url || url.href);
  
  if (urlStr.includes('lock.wasm')) {
    const wasmBuffer = fs.readFileSync('C:/Users/odeda/Desktop/Projects/Nuvio Live Sports Plugin/lock.wasm');
    return new Response(wasmBuffer, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
  }
  
  if (urlStr.includes('/fetch')) {
    
    let reqBody = opts ? opts.body : (url.body ? await url.arrayBuffer() : undefined);
    if (url.arrayBuffer && typeof url.arrayBuffer === 'function' && !reqBody) {
      reqBody = await url.arrayBuffer();
    }
    
    const proxyUrl = 'https://nuvio-proxy.odedararaj456.workers.dev/?url=' + encodeURIComponent(targetOrigin + '/fetch');
    
    try {
      const response = await originalFetch(proxyUrl, {
        method: 'POST',
        headers: {
            'Referer': fullEmbedUrl,
            'Origin': targetOrigin,
            'User-Agent': global.navigator.userAgent,
            'Content-Type': 'application/octet-stream'
        },
        body: reqBody ? Buffer.from(reqBody) : undefined
      });
      
      if (!response.ok) {
          console.error(`[WASM] Proxy fetch failed: ${response.status} ${response.statusText}`);
          console.error(await response.text());
          process.exit(1);
      }
      
      const responseBody = await response.arrayBuffer();
      
      const goatHeader = response.headers.get('goat');
      const newHeaders = new Headers();
      for (let [k,v] of response.headers.entries()) {
          newHeaders.set(k, v);
      }
      
      return new Response(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
      });
    } catch (e) {
      throw e;
    }
  }
  
  return new Response('Not found', { status: 404 });
};

(async () => {
  try {
    const lockPath = require('url').pathToFileURL(require('path').join(process.cwd(), 'lock.js')).href;
    const lock = await import(lockPath);
    await lock.default();
    try {
      await lock.set_stream(process.argv[2], process.argv[3], process.argv[4]);
    } catch (err) {
      console.error("[WASM ERROR from set_stream]", err);
      console.error("String val:", String(err));
      console.error("Type of err:", typeof err);
      if (err && typeof err === 'object') {
          console.error("Err props:", Object.getOwnPropertyNames(err));
      }
      if (err) {
          console.error("Stack:", err.stack);
          console.error("Keys:", Object.keys(err));
          console.error("Message:", err.message);
          console.error("String:", err.toString());
      }
    }
  } catch (err) {
    console.error("[WASM ERROR from init]", err);
    process.exit(1);
  }
})();
