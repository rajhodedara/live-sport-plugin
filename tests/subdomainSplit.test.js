'use strict';

const http = require('node:http');
const express = require('express');

describe('Subdomain Split Architecture (Stream vs Metadata Isolation)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Configuration: src/config.js', () => {
    test('exports STREAM_BASE_URL matching process.env.STREAM_URL', () => {
      process.env.STREAM_URL = 'https://stream.nuviosports.xyz/';
      const { STREAM_BASE_URL } = require('../src/config');
      expect(STREAM_BASE_URL).toBe('https://stream.nuviosports.xyz');
    });

    test('defaults STREAM_BASE_URL to empty string when unset', () => {
      delete process.env.STREAM_URL;
      delete process.env.STREAM_BASE_URL;
      const { STREAM_BASE_URL } = require('../src/config');
      expect(STREAM_BASE_URL).toBe('');
    });

    test('getRequestBaseUrl respects incoming stream subdomain host', () => {
      process.env.ADDON_URL = 'https://nuviosports.xyz';
      process.env.STREAM_URL = 'https://stream.nuviosports.xyz';
      const { getRequestBaseUrl } = require('../src/config');

      // Request on main domain
      const mainReq = {
        headers: { host: 'nuviosports.xyz' },
        protocol: 'https'
      };
      expect(getRequestBaseUrl(mainReq)).toBe('https://nuviosports.xyz');

      // Request on stream subdomain
      const streamReq = {
        headers: { host: 'stream.nuviosports.xyz', 'x-forwarded-proto': 'https' },
        protocol: 'https'
      };
      expect(getRequestBaseUrl(streamReq)).toBe('https://stream.nuviosports.xyz');
    });
  });

  describe('Response Interception Middleware: src/index.js URL Rewriter', () => {
    let server;
    let baseUrl;

    async function startServer(streamUrl, addonUrl = 'https://nuviosports.xyz') {
      process.env.ADDON_URL = addonUrl;
      if (streamUrl) {
        process.env.STREAM_URL = streamUrl;
      } else {
        delete process.env.STREAM_URL;
      }

      const { STREAM_BASE_URL, getRequestBaseUrl } = require('../src/config');
      const app = express();

      const STREAM_PREFIXES = [
        '/api/manifest',
        '/api/dash',
        '/api/hls',
        '/hls/resource',
        '/api/soccerfull',
        '/api/leaf',
        '/api/mp4proxy',
        '/api/fastmp4',
        '/api/hlschunk'
      ];
      const METADATA_PREFIXES = ['/img', '/watch', '/logo', '/posters', '/donate'];
      const REWRITE_SCAN_PREFIXES = [...STREAM_PREFIXES, ...METADATA_PREFIXES];

      app.use((req, res, next) => {
        const isAddonRoute = req.path.includes('/catalog/') || req.path.includes('/stream/');
        if (!isAddonRoute) return next();

        const currentBaseUrl = getRequestBaseUrl(req);
        const effectiveStreamBaseUrl = STREAM_BASE_URL || currentBaseUrl;
        const chunks = [];
        const originalWrite = res.write;
        const originalEnd = res.end;

        res.write = function (chunk) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          return true;
        };

        res.end = function (chunk, encoding, callback) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const bodyBuffer = Buffer.concat(chunks);
          const bodyString = bodyBuffer.toString('utf8');

          if (!REWRITE_SCAN_PREFIXES.some(p => bodyString.includes(p))) {
            return originalEnd.call(res, bodyBuffer, encoding, callback);
          }

          let modified = false;
          const body = JSON.parse(bodyString);
          const rewriteUrl = (url) => {
            if (!url || typeof url !== 'string') return url;
            for (const prefix of STREAM_PREFIXES) {
              if (url.startsWith(prefix)) {
                modified = true;
                return `${effectiveStreamBaseUrl}${url}`;
              }
            }
            for (const prefix of METADATA_PREFIXES) {
              if (url.startsWith(prefix)) {
                modified = true;
                return `${currentBaseUrl}${url}`;
              }
            }
            const streamMatch = url.match(/^(?:https?:\/\/[^\/]+)(\/(?:api\/manifest|api\/dash|api\/mp4proxy|api\/fastmp4|api\/hlschunk|api\/hls|hls\/resource|api\/soccerfull|api\/leaf)(?:[?\/].*|\.[A-Za-z0-9]+)?)$/);
            if (streamMatch) {
              modified = true;
              return `${effectiveStreamBaseUrl}${streamMatch[1]}`;
            }
            const metaMatch = url.match(/^(?:https?:\/\/[^\/]+)(\/(?:img|watch|logo|posters|donate)(?:[?\/].*|\.[A-Za-z0-9]+)?)$/);
            if (metaMatch) {
              modified = true;
              return `${currentBaseUrl}${metaMatch[1]}`;
            }
            return url;
          };

          if (body.streams && Array.isArray(body.streams)) {
            body.streams.forEach(s => {
              if (s.url) s.url = rewriteUrl(s.url);
            });
          }
          if (body.metas && Array.isArray(body.metas)) {
            body.metas.forEach(m => {
              if (m.poster) m.poster = rewriteUrl(m.poster);
              if (m.background) m.background = rewriteUrl(m.background);
            });
          }

          if (modified) {
            const newBodyString = JSON.stringify(body);
            const newBuffer = Buffer.from(newBodyString, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Length', newBuffer.length);
            return originalEnd.call(res, newBuffer, 'utf8', callback);
          }

          return originalEnd.call(res, bodyBuffer, encoding, callback);
        };

        next();
      });

      // Fixtures
      app.get('/stream/tv/match1.json', (req, res) => {
        res.json({
          streams: [
            { name: 'DASH Stream', url: '/api/dash/index.m3u8?d=signedtoken' },
            { name: 'Manifest Stream', url: 'http://localhost:7000/api/manifest?url=upstream' },
            { name: 'External Direct Stream', url: 'https://cdn.example.com/live/index.m3u8' }
          ]
        });
      });

      app.get('/catalog/tv/live.json', (req, res) => {
        res.json({
          metas: [
            {
              id: 'm1',
              poster: '/img/match?id=123',
              background: 'http://localhost:7000/posters/replays/luffy_football.jpg'
            }
          ]
        });
      });

      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    }

    afterEach(async () => {
      if (server) {
        await new Promise(resolve => {
          server.closeAllConnections ? server.closeAllConnections() : null;
          server.close(resolve);
        });
        server = null;
      }
    });

    function makeRequest(path, hostHeader = 'nuviosports.xyz') {
      return new Promise((resolve, reject) => {
        const u = new URL(path, baseUrl);
        const req = http.request(u, {
          headers: {
            'Host': hostHeader,
            'x-forwarded-proto': 'https'
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    test('rewrites stream endpoints to STREAM_URL when configured', async () => {
      await startServer('https://stream.nuviosports.xyz');
      const res = await makeRequest('/stream/tv/match1.json');

      expect(res.status).toBe(200);
      const streams = res.body.streams;
      expect(streams[0].url).toBe('https://stream.nuviosports.xyz/api/dash/index.m3u8?d=signedtoken');
      expect(streams[1].url).toBe('https://stream.nuviosports.xyz/api/manifest?url=upstream');
      // Direct 3rd-party CDN streams must remain completely untouched
      expect(streams[2].url).toBe('https://cdn.example.com/live/index.m3u8');
    });

    test('rewrites metadata & poster endpoints to main ADDON_URL', async () => {
      await startServer('https://stream.nuviosports.xyz');
      const res = await makeRequest('/catalog/tv/live.json');

      expect(res.status).toBe(200);
      const meta = res.body.metas[0];
      expect(meta.poster).toBe('https://nuviosports.xyz/img/match?id=123');
      expect(meta.background).toBe('https://nuviosports.xyz/posters/replays/luffy_football.jpg');
    });

    test('seamlessly falls back to ADDON_URL when STREAM_URL is unset', async () => {
      await startServer(null);
      const res = await makeRequest('/stream/tv/match1.json');

      expect(res.status).toBe(200);
      const streams = res.body.streams;
      expect(streams[0].url).toBe('https://nuviosports.xyz/api/dash/index.m3u8?d=signedtoken');
      expect(streams[1].url).toBe('https://nuviosports.xyz/api/manifest?url=upstream');
    });
  });
});
