const fs = require('fs');
const path = require('path');

class EventTarget {
  constructor() { this.listeners = {}; }
  addEventListener(type, callback) { if (!this.listeners[type]) this.listeners[type] = []; this.listeners[type].push(callback); }
  removeEventListener(type, callback) { if (!this.listeners[type]) return; const i = this.listeners[type].indexOf(callback); if (i !== -1) this.listeners[type].splice(i, 1); }
  dispatchEvent(event) { if (!this.listeners[event.type]) return true; for (const listener of this.listeners[event.type]) listener(event); return !event.defaultPrevented; }
}

class Window extends EventTarget {
  constructor() { super(); this.document = null; }
  setTimeout(cb, ms) { return setTimeout(cb, ms); }
  clearTimeout(id) { clearTimeout(id); }
  setInterval(cb, ms) { return setInterval(cb, ms); }
  clearInterval(id) { clearInterval(id); }
}

class Document extends EventTarget {
  constructor() { super(); this.documentElement = new Element('html'); this.head = new Element('head'); this.body = new Element('body'); }
  createElement(tag) { return new Element(tag); }
  createTextNode(text) { return { nodeType: 3, textContent: text }; }
  getElementById() { return null; }
  querySelector() { return null; }
}

class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.style = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] || null; }
  appendChild(child) { this.children.push(child); }
  removeChild(child) { const i = this.children.indexOf(child); if (i !== -1) this.children.splice(i, 1); }
}

global.Window = Window;
global.Document = Document;
Object.setPrototypeOf(global, Window.prototype);

global.window = global;
global.self = global;

const fullEmbedUrl = process.argv[6] || process.argv[5] || 'https://embedindia.st/embed-noads/rally-tv';
let targetOrigin = process.argv[5] ? (process.argv[5].startsWith('http') ? new URL(process.argv[5]).origin : 'https://embedindia.st') : 'https://embedindia.st';
let searchParams = '';
let pathName = '/embed-noads/rally-tv';
try {
    const u = new URL(fullEmbedUrl);
    targetOrigin = u.origin;
    searchParams = u.search;
    pathName = u.pathname;
} catch(e) {}

global.location = { 
  hostname: 'embedindia.st', 
  href: fullEmbedUrl,
  search: searchParams,
  pathname: pathName
};
global.document = new Document();
global.document.referrer = 'https://embed.st/';
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
  if (name.toLowerCase() === 'indians') return capturedGoat;
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
  
  if (importObject['./gasm_bg.js']) {
    const bg = importObject['./gasm_bg.js'];
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

const { fetchUndici: originalFetch } = require(fs.existsSync(path.join(__dirname, 'services', 'ProviderOutbound.js'))
  ? './services/ProviderOutbound' : '../services/ProviderOutbound');

global.fetch = async (url, opts) => {
  const urlStr = typeof url === 'string' ? url : (url.url || url.href);
  
  if (urlStr.includes('gasm.wasm')) {
    const wasmPath = path.join(__dirname, 'gasm.wasm');
    const wasmBuffer = fs.readFileSync(wasmPath);
    return new Response(wasmBuffer, { status: 200, headers: { 'Content-Type': 'application/wasm' } });
  }
  
  if (urlStr.includes('/fetch')) {
    let reqBody = opts ? opts.body : (url.body ? await url.arrayBuffer() : undefined);
    if (url.arrayBuffer && typeof url.arrayBuffer === 'function' && !reqBody) {
      reqBody = await url.arrayBuffer();
    }
    
    const proxyUrl = targetOrigin + '/fetch';
    
    console.log('POST DATA:', Buffer.from(reqBody).toString('hex'));
    
    try {
      const fetchOpts = opts || (url.headers ? url : {});
      const reqHeaders = new Headers();
      
      if (fetchOpts.headers) {
          if (fetchOpts.headers instanceof Headers) {
              fetchOpts.headers.forEach((value, key) => reqHeaders.set(key, value));
          } else if (Array.isArray(fetchOpts.headers)) {
              for (const [key, value] of fetchOpts.headers) reqHeaders.set(key, value);
          } else {
              for (const key of Object.keys(fetchOpts.headers)) reqHeaders.set(key, fetchOpts.headers[key]);
          }
      }

      reqHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
      reqHeaders.set('Referer', fullEmbedUrl);
      reqHeaders.set('Origin', targetOrigin);
      reqHeaders.set('Content-Type', 'application/octet-stream');
      console.log('HEADERS:', Array.from(reqHeaders.entries()));
      
      const response = await originalFetch(proxyUrl, {
          method: fetchOpts.method || 'POST',
          headers: reqHeaders,
          body: reqBody ? Buffer.from(reqBody) : undefined
      });
      
      if (!response.ok) {
          console.error(`[WASM] Proxy fetch failed: ${response.status} ${response.statusText}`);
          process.exit(1);
      }
      
      const responseBody = await response.arrayBuffer();
      
      let realGoatHeader = null;
      for (let [k,v] of response.headers.entries()) {
          if (k.toLowerCase() === 'indians') realGoatHeader = v;
          if (k.toLowerCase() === 'goat') realGoatHeader = v;
      }
      
      const mockedResponse = new Response(responseBody, {
          status: 200,
          statusText: 'OK',
          headers: new Headers({
              'Content-Type': 'application/octet-stream',
              'indians': realGoatHeader || 'mocked-indians-header',
              'goat': realGoatHeader || 'mocked-goat-header'
          })
      });
      capturedGoat = realGoatHeader;
      
      return mockedResponse;
    } catch (err) {
      console.error(`[WASM] Network error on proxy fetch: ${err.message}`);
      process.exit(1);
    }
  }
  
  return originalFetch(url, opts);
};

(async () => {
  try {
    const lockPath = require('url').pathToFileURL(path.join(__dirname, 'gasm.js')).href;
    const lock = await import(lockPath);
    await lock.default();
    
    if (lock.init_wasm) {
        await lock.init_wasm();
    }
    
    try {
      const u = process.argv[2] === 'EMPTY' ? '' : process.argv[2];
      const e = process.argv[3] === 'EMPTY' ? '' : process.argv[3];
      const i = process.argv[4] === 'EMPTY' ? '' : process.argv[4];
      console.log(`Calling set_stream with: '${u}', '${e}', '${i}'`);
      await lock.set_stream_jw ? await lock.set_stream_jw(u) : await lock.set_stream(u, e, i);
    } catch (err) {
      console.error("[WASM ERROR from set_stream]", err);
      process.exit(1);
    }
  } catch(e) {
    console.error("[WASM] Fatal error in main wrapper:", e);
    process.exit(1);
  }
})();
