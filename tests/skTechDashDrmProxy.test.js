'use strict';

const http = require('http');
const express = require('express');
const SkTechCrypto = require('../src/resolver/sktech/SkTechCrypto');
const SkTechEmbedExtractor = require('../src/resolver/sktech/SkTechEmbedExtractor');
const manifestRouter = require('../src/routes/manifest');

describe('SK Tech DASH Manifest & ClearKey DRM Proxy System', () => {
  let server;
  let serverPort;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(manifestRouter);

    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      baseUrl = `http://127.0.0.1:${serverPort}`;
      done();
    });
  });

  afterAll((done) => {
    if (server) {
      server.close(done);
    } else {
      done();
    }
  });

  describe('SkTechCrypto.formatClearKey()', () => {
    test('normalizes comma-separated multi-keys (audio + video) into base64url', () => {
      const rawMultiKey = '2a19442cb6a65a0d9547b7a887029334:78f4db938c5873b14dffa721a6b979c5,7d7a754c2d5756328cf9bb03b93bf946:5e2eb51889cf8e326f04abf24757205e';
      const parsed = SkTechCrypto.formatClearKey(rawMultiKey);
      expect(parsed).toBeDefined();
      expect(parsed.keyId).toBe('KhlELLamWg2VR7eohwKTNA');
      expect(parsed.key).toBe('ePTbk4xYc7FN_6chprl5xQ');
      expect(parsed.keys).toHaveLength(2);
      expect(parsed.keys[1]).toEqual({
        keyId: 'fXp1TC1XVjKM-bsDuTv5Rg',
        key: 'Xi61GInPjjJvBKvyR1cgXg'
      });
    });

    test('normalizes W3C JSON clear key format', () => {
      const jsonStr = JSON.stringify({
        keys: [{
          kty: 'oct',
          kid: 'a71918fcc2f12066f70b7c39b0e0dcf3',
          k: 'a5e35121d4f6f16694bea15334f14814'
        }]
      });
      const parsed = SkTechCrypto.formatClearKey(jsonStr);
      expect(parsed).toBeDefined();
      expect(parsed.keyId).toBe('pxkY_MLxIGb3C3w5sODc8w');
      expect(parsed.key).toBe('peNRIdT28WaUvqFTNPFIFA');
    });

    test('normalizes single hex colon pair without adding extra keys array', () => {
      const rawHex = 'b9f1cb8a1361457bbd8097f8c2590000:1960274b7ba344cb899eba2e80916774';
      const parsed = SkTechCrypto.formatClearKey(rawHex);
      expect(parsed).toEqual({
        keyId: 'ufHLihNhRXu9gJf4wlkAAA',
        key: 'GWAnS3ujRMuJnrougJFndA'
      });
    });
  });

  describe('SkTechEmbedExtractor.parseDelimited() with Cookie', () => {
    test('correctly parses Cookie header alongside User-Agent, Referer, and Origin', () => {
      const raw = 'https://livetv.hotstar.com/live/cenc/index.mpd|Cookie=hdntl=exp=1792044485~acl=%2f*~data=hdntl&User-Agent=Virat&Referer=https://www.hotstar.com/&Origin=https://www.hotstar.com';
      const parsed = SkTechEmbedExtractor.parseDelimited(raw);
      expect(parsed.url).toBe('https://livetv.hotstar.com/live/cenc/index.mpd');
      expect(parsed.headers['Cookie']).toBe('hdntl=exp=1792044485~acl=%2f*~data=hdntl');
      expect(parsed.headers['User-Agent']).toBe('Virat');
      expect(parsed.headers['Referer']).toBe('https://www.hotstar.com/');
      expect(parsed.headers['Origin']).toBe('https://www.hotstar.com');
    });
  });

  describe('ClearKey License Endpoint (/api/clearkey/license)', () => {
    test('returns W3C ClearKey JSON response from base64url token', async () => {
      const keyObj = {
        keyId: 'ufHLihNhRXu9gJf4wlkAAA',
        key: 'GWAnS3ujRMuJnrougJFndA'
      };
      const token = Buffer.from(JSON.stringify(keyObj)).toString('base64url');

      const res = await fetch(`${baseUrl}/api/clearkey/license?token=${encodeURIComponent(token)}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');

      const body = await res.json();
      expect(body.type).toBe('temporary');
      expect(body.keys).toEqual([
        {
          kty: 'oct',
          kid: 'ufHLihNhRXu9gJf4wlkAAA',
          k: 'GWAnS3ujRMuJnrougJFndA'
        }
      ]);
    });

    test('supports OPTIONS preflight with 204 status', async () => {
      const res = await fetch(`${baseUrl}/api/clearkey/license`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    test('returns multiple key pairs for multi-key token', async () => {
      const multiKeyObj = {
        keys: [
          { kid: 'keyId1', k: 'keyVal1' },
          { kid: 'keyId2', k: 'keyVal2' }
        ]
      };
      const token = Buffer.from(JSON.stringify(multiKeyObj)).toString('base64url');

      const res = await fetch(`${baseUrl}/api/clearkey/license?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kids: ['keyId1', 'keyId2'], type: 'temporary' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.keys).toHaveLength(2);
      expect(body.keys[0]).toEqual({ kty: 'oct', kid: 'keyId1', k: 'keyVal1' });
      expect(body.keys[1]).toEqual({ kty: 'oct', kid: 'keyId2', k: 'keyVal2' });
    });
  });

  describe('SkTechCrypto.buildDashManifestUrl()', () => {
    test('packages upstream URL, token, and headers into a relative manifest URL', () => {
      const upstream = 'https://otte.cache.aiv-cdn.net/live/clients/dash/cenc.mpd';
      const ck = { keyId: 'abc', key: 'def' };
      const headers = { 'Cookie': 'cookieVal', 'User-Agent': 'TestUA' };

      const manifestUrl = SkTechCrypto.buildDashManifestUrl(upstream, ck, headers);
      expect(manifestUrl).toContain('/api/manifest.mpd?url=https%3A%2F%2Fotte.cache.aiv-cdn.net');
      expect(manifestUrl).toContain('token=');
      expect(manifestUrl).toContain('cookie=cookieVal');
      expect(manifestUrl).toContain('ua=TestUA');
    });
  });

  describe('parseClearKeyToken()', () => {
    test('parses base64url JSON token with keyId and key', () => {
      const raw = { keyId: 'ufHLihNhRXu9gJf4wlkAAA', key: 'GWAnS3ujRMuJnrougJFndA' };
      const token = Buffer.from(JSON.stringify(raw)).toString('base64url');
      const parsed = manifestRouter.parseClearKeyToken(token);
      expect(parsed).toEqual([
        { kty: 'oct', kid: 'ufHLihNhRXu9gJf4wlkAAA', k: 'GWAnS3ujRMuJnrougJFndA' }
      ]);
    });

    test('parses base64url JSON token with keys array and hex strings', () => {
      const raw = {
        keys: [{
          kty: 'oct',
          kid: 'a71918fcc2f12066f70b7c39b0e0dcf3',
          k: 'a5e35121d4f6f16694bea15334f14814'
        }]
      };
      const token = Buffer.from(JSON.stringify(raw)).toString('base64url');
      const parsed = manifestRouter.parseClearKeyToken(token);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].kid).toBe('pxkY_MLxIGb3C3w5sODc8w');
      expect(parsed[0].k).toBe('peNRIdT28WaUvqFTNPFIFA');
    });

    test('parses raw colon-separated hex string', () => {
      const raw = 'b9f1cb8a1361457bbd8097f8c2590000:1960274b7ba344cb899eba2e80916774';
      const parsed = manifestRouter.parseClearKeyToken(raw);
      expect(parsed).toEqual([
        { kty: 'oct', kid: 'ufHLihNhRXu9gJf4wlkAAA', k: 'GWAnS3ujRMuJnrougJFndA' }
      ]);
    });

    test('handles empty or invalid inputs gracefully', () => {
      expect(manifestRouter.parseClearKeyToken('')).toEqual([]);
      expect(manifestRouter.parseClearKeyToken(null)).toEqual([]);
      expect(manifestRouter.parseClearKeyToken(undefined)).toEqual([]);
    });

    test('supports token passed directly as a JavaScript object', () => {
      const obj = { keyId: 'ufHLihNhRXu9gJf4wlkAAA', key: 'GWAnS3ujRMuJnrougJFndA' };
      const parsed = manifestRouter.parseClearKeyToken(obj);
      expect(parsed).toEqual([
        { kty: 'oct', kid: 'ufHLihNhRXu9gJf4wlkAAA', k: 'GWAnS3ujRMuJnrougJFndA' }
      ]);
    });
  });

  describe('generateClearKeyPssh() & toHyphenatedGuid()', () => {
    test('generates valid version 1 ISO-BMFF PSSH box for ClearKey', () => {
      const kidHex = 'a71918fcc2f12066f70b7c39b0e0dcf3';
      const psshB64 = manifestRouter.generateClearKeyPssh(kidHex);
      expect(psshB64).toBeTruthy();

      const psshBuf = Buffer.from(psshB64, 'base64');
      // Box size: 52 bytes
      expect(psshBuf.length).toBe(52);
      expect(psshBuf.readUInt32BE(0)).toBe(52);
      expect(psshBuf.toString('ascii', 4, 8)).toBe('pssh');
      expect(psshBuf.readUInt8(8)).toBe(1); // Version 1
      expect(psshBuf.readUInt8(9)).toBe(0); // Flag 0
      expect(psshBuf.readUInt8(10)).toBe(0); // Flag 1
      expect(psshBuf.readUInt8(11)).toBe(0); // Flag 2
      // SystemID: 1077efec-c0b2-4d02-ace3-3c1e52e2fb4b
      expect(psshBuf.subarray(12, 28).toString('hex')).toBe('1077efecc0b24d02ace33c1e52e2fb4b');
      // KID count: 1
      expect(psshBuf.readUInt32BE(28)).toBe(1);
      // KID: matches input hex
      expect(psshBuf.subarray(32, 48).toString('hex')).toBe(kidHex);
      // Data size: 0
      expect(psshBuf.readUInt32BE(48)).toBe(0);
    });

    test('supports custom System ID for ExoPlayer ClearKey UUID', () => {
      const kidHex = 'a71918fcc2f12066f70b7c39b0e0dcf3';
      const psshB64 = manifestRouter.generateClearKeyPssh(kidHex, manifestRouter.CLEARKEY_UUID_EXOPLAYER);
      const psshBuf = Buffer.from(psshB64, 'base64');
      expect(psshBuf.subarray(12, 28).toString('hex')).toBe('e2719d58a985b3c9781ab030af78d30e');
    });

    test('toHyphenatedGuid produces uppercase hyphenated GUID', () => {
      const guid = manifestRouter.toHyphenatedGuid('a71918fcc2f12066f70b7c39b0e0dcf3');
      expect(guid).toBe('A71918FC-C2F1-2066-F70B-7C39B0E0DCF3');

      const guidFromB64 = manifestRouter.toHyphenatedGuid('pxkY_MLxIGb3C3w5sODc8w');
      expect(guidFromB64).toBe('A71918FC-C2F1-2066-F70B-7C39B0E0DCF3');
    });
  });

  describe('stripDrmProtection()', () => {
    test('removes Widevine and PlayReady ContentProtection tags case-insensitively', () => {
      const sampleMpd = `<MPD>
  <Period>
    <AdaptationSet>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <cenc:pssh>WidevinePsshData</cenc:pssh>
      </ContentProtection>
      <ContentProtection schemeIdUri="urn:uuid:9A04F079-9840-4286-AB92-E65BE0885F95" value="MSPR 2.0"/>
      <ContentProtection value="Widevine"/>
      <Representation id="1"/>
    </AdaptationSet>
  </Period>
</MPD>`;

      const stripped = manifestRouter.stripDrmProtection(sampleMpd);
      expect(stripped).not.toContain('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
      expect(stripped).not.toContain('9A04F079-9840-4286-AB92-E65BE0885F95');
      expect(stripped).not.toContain('WidevinePsshData');
      expect(stripped).not.toContain('value="Widevine"');
      expect(stripped).toContain('<Representation id="1"/>');
    });
  });

  describe('DASH Manifest Proxy Endpoint (/api/manifest.mpd)', () => {
    let mockUpstreamServer;
    let mockUpstreamPort;
    let mockUpstreamUrl;

    afterEach(() => jest.restoreAllMocks());

    beforeAll((done) => {
      const mockApp = express();
      mockApp.get('/live/stream.mpd', (req, res) => {
        const mpdBody = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <BaseURL>dash/</BaseURL>
  <Period id="0">
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc">
        <cenc:pssh>UpstreamWidevinePsshInCenc</cenc:pssh>
      </ContentProtection>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <cenc:pssh>UpstreamWidevinePssh</cenc:pssh>
      </ContentProtection>
      <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95" value="PlayReady"/>
      <Representation id="video_1080p" bandwidth="5000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
        res.setHeader('Content-Type', 'application/dash+xml');
        res.send(mpdBody);
      });

      mockUpstreamServer = http.createServer(mockApp);
      mockUpstreamServer.listen(0, '127.0.0.1', () => {
        mockUpstreamPort = mockUpstreamServer.address().port;
        mockUpstreamUrl = `http://127.0.0.1:${mockUpstreamPort}/live/stream.mpd`;
        done();
      });
    });

    afterAll((done) => {
      if (mockUpstreamServer) {
        mockUpstreamServer.close(done);
      } else {
        done();
      }
    });

    test('rewrites relative BaseURL, strips Widevine/PlayReady, overwrites cenc Widevine PSSH, and injects ExoPlayer af78d30e UUID + cenc:default_KID', async () => {
      // This is a formatting test with a trusted local fixture. The real
      // external transport now correctly rejects loopback, tested separately.
      jest.spyOn(require('../src/services/GuardedOutbound'), 'guardedFetch')
        .mockImplementation((url, opts) => fetch(url, { headers: opts.headers }));
      const keyObj = {
        keyId: 'a71918fcc2f12066f70b7c39b0e0dcf3',
        key: 'a5e35121d4f6f16694bea15334f14814'
      };
      const token = Buffer.from(JSON.stringify(keyObj)).toString('base64url');

      const proxyUrl = `${baseUrl}/api/manifest.mpd?url=${encodeURIComponent(mockUpstreamUrl)}&token=${encodeURIComponent(token)}`;
      const res = await fetch(proxyUrl);
      expect(res.status).toBe(200);

      const mpdText = await res.text();

      // 1. BaseURL resolved against upstream base
      expect(mpdText).toContain(`<BaseURL>http://127.0.0.1:${mockUpstreamPort}/live/dash/</BaseURL>`);
      expect(mpdText).not.toContain('<BaseURL>dash/</BaseURL>');

      // 2. Widevine & PlayReady stripped, and upstream Widevine PSSH inside cenc overwritten
      expect(mpdText).not.toContain('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed');
      expect(mpdText).not.toContain('9a04f079-9840-4286-ab92-e65be0885f95');
      expect(mpdText).not.toContain('UpstreamWidevinePssh');
      expect(mpdText).not.toContain('UpstreamWidevinePsshInCenc');

      // 3. ClearKey UUID with af78d30e and W3C UUID injected
      expect(mpdText).toContain('urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e');
      expect(mpdText).not.toContain('e2719d58-a985-b3c9-781a-b030a7d0e82e');
      expect(mpdText).toContain('urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b');

      // 4. cenc:default_KID formatted as hyphenated uppercase GUID
      expect(mpdText).toContain('cenc:default_KID="A71918FC-C2F1-2066-F70B-7C39B0E0DCF3"');

      // 5. cenc:pssh box present and dashif:Laurl present
      expect(mpdText).toContain('<cenc:pssh>');
      expect(mpdText).toContain('<dashif:Laurl');
      expect(mpdText).toContain('<dashif:laurl');
      expect(mpdText).toContain('<clearkey:Laurl');
    });
  });

  describe('Stream format prioritization (Plain HLS over DASH DRM) and StreamEntity', () => {
    const { compareStreams, streamFormatTier } = require('../src/services/LanguagePriorityService');
    const StreamEntity = require('../src/domain/StreamEntity');

    test('StreamEntity preserves language property', () => {
      const entity = new StreamEntity({
        name: 'SK Tech',
        title: 'Sony SAB HD',
        url: 'https://cdn.example.com/sab.m3u8',
        language: 'Hindi'
      });
      expect(entity.language).toBe('Hindi');
    });

    test('streamFormatTier assigns 0 to plain HLS and 2 to DASH DRM', () => {
      const plainHls = { name: '⚡ Direct Stream', url: 'https://cdn.example.com/stream.m3u8' };
      const dashDrm = { name: '⚡ Direct Stream', url: 'https://cdn.example.com/stream.mpd', clearkey: { keyId: 'abc' } };
      const otherStream = { name: '⚡ Direct Stream', url: 'https://cdn.example.com/video.mp4' };

      expect(streamFormatTier(plainHls)).toBe(0);
      expect(streamFormatTier(dashDrm)).toBe(2);
      expect(streamFormatTier(otherStream)).toBe(1);
    });

    test('prioritizes unencrypted HLS above DASH DRM of the same language', () => {
      const plainHls = {
        name: '⚡ Direct Stream',
        title: 'Sony SAB HD (Plain HLS)',
        language: 'Hindi',
        url: 'https://cdn.example.com/live/sab.m3u8',
        score: 90
      };
      const dashDrm = {
        name: '⚡ Direct Stream',
        title: 'Sony SAB HD (DASH DRM)',
        language: 'Hindi',
        url: 'https://cdn.example.com/live/sab.mpd',
        clearkey: { keyId: 'abc' },
        score: 95
      };

      const sorted = [dashDrm, plainHls].sort((a, b) => compareStreams(a, b, []));
      expect(sorted[0].title).toBe('Sony SAB HD (Plain HLS)');
      expect(sorted[1].title).toBe('Sony SAB HD (DASH DRM)');
    });
  });
});
