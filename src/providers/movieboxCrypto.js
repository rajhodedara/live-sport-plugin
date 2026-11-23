'use strict';

const crypto = require('crypto');

const GATEWAY_SECRET_B64 = '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O';
const GATEWAY_SECRET = Buffer.from(GATEWAY_SECRET_B64, 'base64');
const CERT_TAG = '03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410oneroom';
const PACKAGE_NAME = 'com.community.mbox.tv';
const VERSION_CODE = 50020132;
const API_HOST = 'https://tv.aoneroom.com';
const TOKEN_TTL_MS = 300_000;

const DEVICE_ID = crypto.randomBytes(16).toString('hex');
const GAID = crypto.randomUUID ? crypto.randomUUID() : '38400000-8cf0-11bd-b23e-10b96e4ef00d';

function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

function canonicalPath(p) {
  if (!p.includes('?')) return p;
  const [pathPart, queryPart] = p.split('?');
  if (!queryPart) return p;
  const entries = queryPart.split('&').map(pair => {
    const idx = pair.indexOf('=');
    return idx === -1 ? [pair, ''] : [pair.slice(0, idx), pair.slice(idx + 1)];
  });
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const sortedQuery = entries.map(([k, v]) => (v !== '' ? `${k}=${v}` : k)).join('&');
  return `${pathPart}?${sortedQuery}`;
}

function buildHeaders(method, path, body = null) {
  const nowMs = Date.now();

  // 1. x-client-token
  const revMsStr = String(nowMs).split('').reverse().join('');
  const tokenHash = md5Hex(revMsStr);
  const xClientToken = `${nowMs},${tokenHash}`;

  // 2. X-Client-Build
  const s = Math.floor(nowMs / 1000);
  const ms = (nowMs % 1000) * 1000;
  const rnd = Math.floor(Math.random() * 1000);
  const part1 = `${s}${String(ms).padStart(6, '0')}${rnd}`;
  const buildHash = md5Hex(CERT_TAG + part1);
  const xClientBuild = `${part1}.${buildHash}`;

  // 3. x-client-info
  const clientInfo = {
    device_id: DEVICE_ID,
    os_version: '14',
    gaid: GAID,
    package_name: PACKAGE_NAME,
    version_code: VERSION_CODE,
    'X-Client-Build': xClientBuild
  };
  const xClientInfo = JSON.stringify(clientInfo);

  // 4. Canonical path & 5. x-tr-signature
  const cPath = canonicalPath(path);
  const bodyBytes = body !== null && body !== undefined ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')) : null;
  const bodyLenStr = bodyBytes !== null ? String(bodyBytes.length) : '';
  const bodyMd5Str = bodyBytes !== null ? md5Hex(bodyBytes) : '';

  const signString = `${method}\napplication/json\napplication/json\n${bodyLenStr}\n${nowMs}\n${bodyMd5Str}\n${cPath}`;
  const mac = crypto.createHmac('md5', GATEWAY_SECRET).update(signString).digest('base64');
  const xTrSignature = `${nowMs}|2|${mac}`;

  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Client-Build': xClientBuild,
    'x-client-token': xClientToken,
    'x-client-info': xClientInfo,
    'x-tr-signature': xTrSignature,
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14; AFTMM Build/UTT2.231215.006) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  };
}

let _cachedToken = null;
let _cacheExpiry = 0;
let _inflightTokenPromise = null;

async function getVisitorToken(fetchFn) {
  const now = Date.now();
  if (_cachedToken && now < _cacheExpiry) {
    return _cachedToken;
  }
  if (_inflightTokenPromise) {
    return _inflightTokenPromise;
  }

  _inflightTokenPromise = (async () => {
    try {
      const path = '/wefeed-tv-bff/user/visitor-login?host=tv.aoneroom.com';
      const body = '{}';
      const headers = buildHeaders('POST', path, body);
      const url = `${API_HOST}${path}`;

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body,
        timeoutMs: 8000,
        attempts: 2
      });

      if (!res) throw new Error('No response from visitor-login');
      let data;
      if (typeof res.json === 'function') {
        data = await res.json();
      } else if (typeof res.text === 'function') {
        const text = await res.text();
        data = JSON.parse(text);
      } else {
        data = res;
      }

      if (data && data.code === 0 && data.data && data.data.token) {
        _cachedToken = data.data.token;
        _cacheExpiry = Date.now() + TOKEN_TTL_MS;
        return _cachedToken;
      }
      throw new Error(`visitor-login failed: ${JSON.stringify(data)}`);
    } finally {
      _inflightTokenPromise = null;
    }
  })();

  return _inflightTokenPromise;
}

async function makeMovieBoxRequest(path, fetchFn, { method = 'GET', body = null, token = null } = {}) {
  const bodyStr = body !== null && body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  const headers = buildHeaders(method, path, bodyStr);
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const url = `${API_HOST}${path}`;

  const res = await fetchFn(url, {
    method,
    headers,
    body: bodyStr,
    timeoutMs: 8000,
    attempts: 2
  });

  if (!res) throw new Error(`Empty response for ${path}`);
  let data;
  if (typeof res.json === 'function') {
    data = await res.json();
  } else if (typeof res.text === 'function') {
    const text = await res.text();
    data = JSON.parse(text);
  } else {
    data = res;
  }

  if (!data || data.code !== 0) {
    throw new Error(`MovieBox API error on ${path}: ${JSON.stringify(data)}`);
  }
  return data.data;
}

module.exports = {
  buildHeaders,
  getVisitorToken,
  makeMovieBoxRequest,
  API_HOST,
  TOKEN_TTL_MS
};
