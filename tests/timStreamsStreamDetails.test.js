'use strict';

// Provider WASM/network bootstrap is never exercised here.
jest.mock('../src/services/StreamedWasmPool', () => ({
  resolveWasmStream: jest.fn(() => { throw new Error('Unexpected WASM execution in unit fixture'); }),
  destroy: jest.fn(async () => {})
}));

process.env.NODE_ENV = 'test';

const HlsQualityProbe = require('../src/services/HlsQualityProbe');
const TimStreamsProvider = require('../src/providers/TimStreamsProvider');
const { applyParsedPlaylistQuality } = require('../src/streams');

// Real H.264 SPS captured from a live TimStreams segment (high profile, 1920x1080).
const REAL_1080P_SPS = '0000016764002aacd900780227e5c05a808080a0000003002a83a68001e30632c000000168eaef2c';

/** Minimal MSB-first bit writer so fixtures do not depend on the parser. */
function bitWriter() {
  const bits = [];
  const api = {
    bit(v) { bits.push(v & 1); return api; },
    bits(v, n) { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); return api; },
    ue(v) {
      const code = v + 1;
      const len = 32 - Math.clz32(code);
      for (let i = 0; i < len - 1; i++) bits.push(0);
      for (let i = len - 1; i >= 0; i--) bits.push((code >> i) & 1);
      return api;
    },
    toBuffer() {
      const padded = bits.concat([1]); // rbsp_stop_one_bit
      while (padded.length % 8) padded.push(0);
      const out = Buffer.alloc(padded.length / 8);
      padded.forEach((b, i) => { out[i >> 3] |= b << (7 - (i & 7)); });
      return out;
    }
  };
  return api;
}

function h264Sps1920() {
  return Buffer.from(REAL_1080P_SPS, 'hex');
}

function h264Sps4k() {
  const w = bitWriter();
  w.bits(100, 8).bits(0, 8).bits(51, 8); // profile, constraint flags, level
  w.ue(0); // sps id
  w.ue(1); // chroma_format_idc 4:2:0
  w.ue(0).ue(0); // bit depths
  w.bit(0).bit(0); // qpprime, scaling matrix
  w.ue(0); // log2_max_frame_num_minus4
  w.ue(0).ue(0); // pic_order_cnt_type 0 + log2_max_poc_lsb_minus4
  w.ue(1); // max_num_ref_frames
  w.bit(0); // gaps allowed
  w.ue(3840 / 16 - 1).ue(2160 / 16 - 1); // frame size
  w.bit(1).bit(1).bit(0).bit(0); // frame_mbs_only, direct_8x8, cropping, vui
  return Buffer.concat([Buffer.from([0, 0, 1, 0x67]), w.toBuffer()]);
}

function hevcSps4k() {
  const w = bitWriter();
  w.bits(0, 4).bits(0, 3).bit(1); // vps id, max_sub_layers_minus1, nesting
  w.bits(0, 2).bit(0).bits(1, 5); // profile space/tier/profile idc
  w.bits(0, 32).bits(0, 48).bits(153, 8); // compatibility, constraints, level
  w.ue(0); // sps id
  w.ue(1); // chroma_format_idc
  w.ue(3840).ue(2160); // luma samples
  w.bit(0); // conformance window
  return Buffer.concat([Buffer.from([0, 0, 1, 0x42, 0x01]), w.toBuffer()]);
}

const CLOAK = 42;
function cloakHeader() {
  const head = Buffer.alloc(CLOAK);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(1024, 4);
  head.write('WEBPVP8L', 8, 'latin1');
  return head;
}

function tsPackets() {
  const packet = Buffer.alloc(188);
  packet[0] = 0x47;
  return Buffer.concat([packet, packet, packet]);
}

function mediaPlaylist(duration = 6.4) {
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n` +
    `#EXTINF:${duration.toFixed(3)},\nhttps://cdn.example/live/seg-1.image?token=a\n` +
    `#EXTINF:${duration.toFixed(3)},\nhttps://cdn.example/live/seg-2.image?token=a\n`;
}

function fakeProbeFetch({ totalBytes = 15360000, segment = null, playlist = null } = {}) {
  const calls = [];
  const fetchImpl = jest.fn(async (url) => {
    calls.push(url);
    if (/\.m3u8(\?|$)/.test(url)) {
      return { ok: true, status: 200, headers: {}, text: async () => playlist || mediaPlaylist() };
    }
    const body = segment || Buffer.concat([cloakHeader(), tsPackets(), h264Sps4k()]);
    return {
      ok: true,
      status: 206,
      headers: { 'content-range': `bytes 0-${body.length - 1}/${totalBytes}` },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    };
  });
  return { fetchImpl, calls };
}

describe('HlsQualityProbe — Annex-B parameter set parsing', () => {
  test('reads 1920x1080 from a real live TimStreams SPS', () => {
    const dims = HlsQualityProbe.parseAnnexBResolution(h264Sps1920());
    expect(dims).toEqual({ width: 1920, height: 1080, codec: 'h264' });
  });

  test('reads 3840x2160 from a high-profile H.264 SPS', () => {
    const dims = HlsQualityProbe.parseAnnexBResolution(h264Sps4k());
    expect(dims).toEqual({ width: 3840, height: 2160, codec: 'h264' });
  });

  test('reads 3840x2160 from an HEVC SPS', () => {
    const dims = HlsQualityProbe.parseAnnexBResolution(hevcSps4k());
    expect(dims).toEqual({ width: 3840, height: 2160, codec: 'hevc' });
  });

  test('ignores a buffer with no parameter set', () => {
    expect(HlsQualityProbe.parseAnnexBResolution(Buffer.from('no-start-codes-here'))).toBeNull();
  });

  test('strips the 42-byte RIFF/WEBP cloak before the TS sync check', () => {
    const cloaked = Buffer.concat([cloakHeader(), tsPackets()]);
    expect(HlsQualityProbe.looksLikeTs(cloaked)).toBe(false);
    expect(HlsQualityProbe.looksLikeTs(HlsQualityProbe.stripCloak(cloaked))).toBe(true);
  });

  test('maps heights to display tiers and never invents 4K', () => {
    expect(HlsQualityProbe.tierForHeight(2160)).toEqual({ resolution: '2160p', quality: '4K UHD' });
    expect(HlsQualityProbe.tierForHeight(1080)).toEqual({ resolution: '1080p', quality: 'FHD' });
    expect(HlsQualityProbe.tierForHeight(720)).toEqual({ resolution: '720p', quality: 'HD' });
    expect(HlsQualityProbe.tierForHeight(480)).toEqual({ resolution: '480p', quality: 'SD' });
  });

  test('formats bitrate in the addon-wide label convention', () => {
    expect(HlsQualityProbe.formatBitrate(19200000)).toBe('19.2 Mbps');
    expect(HlsQualityProbe.formatBitrate(840000)).toBe('840 kbps');
    expect(HlsQualityProbe.formatBitrate(0)).toBe('');
  });
});

describe('HlsQualityProbe — measurement, caching and failure behaviour', () => {
  test('derives resolution and bitrate from one media playlist', async () => {
    const probe = new HlsQualityProbe();
    const { fetchImpl } = fakeProbeFetch({ totalBytes: 15360000 });
    const result = await probe.probe('https://tims.example/main/secure/abc/999/tntsports1-uk.m3u8', {
      fetch: fetchImpl,
      referer: 'https://embed.example'
    });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      width: 3840,
      height: 2160,
      resolution: '2160p',
      quality: '4K UHD',
      bitrate: '19.2 Mbps',
      duration: 6.4
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // playlist + one ranged segment read
    expect(fetchImpl.mock.calls[1][1].headers.Range).toBe('bytes=0-524287');
  });

  test('caches by token-free slug, so a re-mint does not re-probe', async () => {
    const probe = new HlsQualityProbe();
    const { fetchImpl } = fakeProbeFetch();
    await probe.probe('https://tims.example/main/secure/aaaa/111/tntsports1-uk.m3u8', { fetch: fetchImpl });
    const second = await probe.probe('https://tims.example/main/secure/bbbb/222/tntsports1-uk.m3u8', { fetch: fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(true);
    expect(second.quality).toBe('4K UHD');
  });

  test('returns null for a master playlist instead of guessing a rendition', async () => {
    const probe = new HlsQualityProbe();
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nv1/prog.m3u8\n';
    const { fetchImpl } = fakeProbeFetch({ playlist: master });
    await expect(probe.probe('https://cdn.example/master.m3u8', { fetch: fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('keeps bitrate when no SPS is present, and does not claim 4K', async () => {
    const probe = new HlsQualityProbe();
    const { fetchImpl } = fakeProbeFetch({ segment: Buffer.concat([cloakHeader(), Buffer.alloc(600, 7)]) });
    const result = await probe.probe('https://tims.example/main/secure/cccc/333/sky-sports-plus.m3u8', { fetch: fetchImpl });

    expect(result).toMatchObject({ resolution: null, quality: null, bitrate: '19.2 Mbps' });
  });

  test('fails soft and negatively caches a broken source', async () => {
    const probe = new HlsQualityProbe();
    const fetchImpl = jest.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(probe.probe('https://tims.example/main/secure/dddd/444/stan-sport.m3u8', { fetch: fetchImpl })).resolves.toBeNull();
    await expect(probe.probe('https://tims.example/main/secure/eeee/555/stan-sport.m3u8', { fetch: fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('never throws without a fetch implementation or a valid URL', async () => {
    const probe = new HlsQualityProbe();
    await expect(probe.probe('not-a-url', { fetch: jest.fn() })).resolves.toBeNull();
    await expect(probe.probe('https://cdn.example/a.m3u8', {})).resolves.toBeNull();
  });
});

describe('TimStreamsProvider — stream details on the row', () => {
  const breaker = { wrap: (n, f) => ({ fire: f }), wrapSync: (n, f) => ({ fire: f }) };
  const embedUrl = 'https://ehgembxe.cfd/e0lyrkhr-8973';

  function makeProvider(qualityProbe) {
    const provider = new TimStreamsProvider({ circuitBreaker: breaker, hlsQualityProbe: qualityProbe });
    provider.extractM3u8 = jest.fn().mockResolvedValue({
      m3u8: 'https://tims-001.sytes.net/main/secure/abc/1793829380/tntsports1-uk.m3u8',
      referer: 'https://ehgembxe.cfd'
    });
    return provider;
  }

  test('publishes the upstream broadcaster and measured quality, without refetching the schedule', async () => {
    const probe = {
      probe: jest.fn().mockResolvedValue({ resolution: '2160p', quality: '4K UHD', bitrate: '19.2 Mbps' })
    };
    const provider = makeProvider(probe);
    const getMatches = jest.spyOn(provider, 'getMatches');

    const rows = await provider.resolveStream('ignored-id', 'football', 'Liverpool @ Fenerbahce', {
      id: 'ignored-id',
      name: 'TNT Sports 1',
      url: embedUrl
    });

    expect(getMatches).not.toHaveBeenCalled();
    const direct = rows.find(row => row.url);
    expect(direct.title).toBe('(TNT Sports 1) Liverpool @ Fenerbahce');
    expect(direct.channelName).toBe('TNT Sports 1');
    expect(direct.canonicalChannel).toBe('TNT Sports 1');
    expect(direct._source).toBe('timstreams');
    expect(direct.resolution).toBe('2160p');
    expect(direct.quality).toBe('4K UHD');
    expect(direct.bitrate).toBe('19.2 Mbps');
    expect(probe.probe).toHaveBeenCalledTimes(1);

    const web = rows.find(row => row.externalUrl);
    expect(web.title).toBe('TimStreams (TNT Sports 1) (Web)');
    expect(web.channelName).toBe('TNT Sports 1');
  });

  test('keeps the previous HD fallback when no probe is available', async () => {
    const provider = makeProvider(null);
    const rows = await provider.resolveStream('ignored-id', 'football', 'Liverpool @ Fenerbahce', {
      id: 'ignored-id',
      name: 'TNT Sports 1',
      url: embedUrl
    });
    const direct = rows.find(row => row.url);
    expect(direct.resolution).toBe('HD');
    expect(direct.bitrate).toBeNull(); // StreamEntity normalises a missing bitrate to null
    expect(direct.title).toBe('(TNT Sports 1) Liverpool @ Fenerbahce');
  });

  test('survives a probe that returns nothing', async () => {
    const provider = makeProvider({ probe: jest.fn().mockResolvedValue(null) });
    const rows = await provider.resolveStream('ignored-id', 'football', 'Test Match', {
      id: 'ignored-id', name: 'Sky Sports+', url: embedUrl
    });
    const direct = rows.find(row => row.url);
    expect(direct.resolution).toBe('HD');
    expect(direct.quality).toBeUndefined();
  });

  test('keeps channelName on catalogue sources', async () => {
    const provider = new TimStreamsProvider({ circuitBreaker: breaker });
    provider.fetchData = {
      fire: async () => ({
        events: [{
          url: 'liverpool-v-fenerbahce',
          name: 'Liverpool @ Fenerbahce',
          genre: 'football',
          time: null,
          streams: [{ name: 'TNT Sports 1', url: embedUrl }]
        }]
      })
    };

    const matches = await provider.getMatches();
    expect(matches[0].sources[0]).toMatchObject({
      name: 'TNT Sports 1',
      channelName: 'TNT Sports 1',
      url: embedUrl
    });
  });

  test('strips parentheses from feed labels so the row extractor still works', () => {
    const provider = new TimStreamsProvider({ circuitBreaker: breaker });
    expect(provider.formatChannelLabel('Sky Sports+ (UK)')).toBe('Sky Sports+ UK');
    expect(provider.formatChannelLabel(null)).toBe('');
  });
});

describe('applyParsedPlaylistQuality — measured tier survives a media playlist', () => {
  test('a media playlist\u2019s generic HD does not erase a measured 4K tier', () => {
    const stream = { resolution: '2160p', quality: '4K UHD', bitrate: '19.2 Mbps' };
    applyParsedPlaylistQuality(stream, { qualityTag: 'HD', resolution: null, bitrateTag: '' });
    expect(stream).toEqual({ resolution: '2160p', quality: '4K UHD', bitrate: '19.2 Mbps' });
  });

  test('a master playlist still overrides everything it declares', () => {
    const stream = { resolution: '2160p', quality: '4K UHD', bitrate: '19.2 Mbps' };
    applyParsedPlaylistQuality(stream, {
      qualityTag: '1080p60', resolution: '1920x1080', bitrateTag: '6.2 Mbps'
    });
    expect(stream).toEqual({ resolution: '1920x1080', quality: '1080p60', bitrate: '6.2 Mbps' });
  });

  test('an unlabelled stream still falls back to the parsed HD tag', () => {
    const stream = {};
    applyParsedPlaylistQuality(stream, { qualityTag: 'HD', resolution: null, bitrateTag: '' });
    expect(stream.quality).toBe('HD');
  });
});
