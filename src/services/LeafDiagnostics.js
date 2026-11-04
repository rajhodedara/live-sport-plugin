'use strict';

// Diagnostics report metadata reachability only. The guarded fetch adapter is
// supplied by the script; this module cannot open a transport on its own.
const { validateLeafManifestUrl } = require('./GuardedEgressPolicy');
const METADATA_LIMIT = 256 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function safeOrigin(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch (_) { return null; }
}

function tokenExpiry(value) {
  try {
    const token = new URL(value).searchParams.get('ft');
    const claim = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isSafeInteger(claim.exp) && claim.exp > 0 ? claim.exp : null;
  } catch (_) { return null; }
}

function diagnosticErrorCode(error) {
  if (error?.code === 'ERR_OUTBOUND_BLOCKED') return 'ERR_OUTBOUND_BLOCKED';
  if (error?.code === 'ERR_OUTBOUND_CAPACITY' || /^ERR_NATIVE_(POOL|SLOT)_(BUSY|CAPACITY)$/.test(error?.code || '')) return 'ERR_OUTBOUND_CAPACITY';
  if (error?.code === 'ERR_OUTBOUND_BODY_LIMIT') return 'ERR_OUTBOUND_BODY_LIMIT';
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') return 'ERR_LEAF_DIAGNOSTIC_TIMEOUT';
  if (error?.name === 'AbortError') return 'ERR_LEAF_DIAGNOSTIC_ABORTED';
  return 'ERR_LEAF_DIAGNOSTIC_REQUEST';
}

const playlistLines = text => String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const isTsSegment = line => !line.startsWith('#') && /\.ts(?:[?#]|$)/i.test(line);

function classifyPlaylist(text) {
  const lines = playlistLines(text);
  return {
    valid: lines[0] === '#EXTM3U',
    kind: lines.some(line => line.startsWith('#EXT-X-STREAM-INF:')) ? 'master' :
      lines.some(line => line.startsWith('#EXTINF:')) ? 'media' : 'empty',
    bytes: Buffer.byteLength(String(text), 'utf8'),
    segments: lines.filter(isTsSegment).length,
    notice: /stream_notice|_antipiracy/i.test(text)
  };
}

function httpStatus(response) {
  return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
}

async function runLeafDiagnostics({ base, probeId = null, config = {}, safeFetch }) {
  const result = {
    ok: false, scope: 'metadata-only', playback: 'NOT_RUN', apiOrigin: safeOrigin(base),
    config: {
      installConfigured: Boolean(config.installConfigured),
      apiOverrideConfigured: Boolean(config.apiOverrideConfigured),
      leafProxyEnvPresent: Boolean(config.leafProxyEnvPresent),
      warpProxyEnvPresent: Boolean(config.warpProxyEnvPresent),
      damiProxyEnvPresent: Boolean(config.damiProxyEnvPresent)
    },
    catalogStatus: null, matches: null, channels: null, probeSelected: false,
    streamStatus: null, streamEntries: null, papacitoUrls: null,
    unverifiedTokenExpiry: null, playlist: null, segment: null, verdict: 'NOT_RUN'
  };
  const jsonOptions = { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeoutMs: 12000, maxBodyBytes: METADATA_LIMIT, guardExternal: true };
  try {
    const response = await safeFetch(`${base}/catalog/sport/sports_live.json`, jsonOptions);
    result.catalogStatus = httpStatus(response);
    if (response?.ok && !response.bodyTruncated) {
      const body = await response.json();
      const metas = Array.isArray(body.metas) ? body.metas : [];
      result.matches = metas.filter(meta => !String(meta.id).startsWith('leaf:')).length;
      result.channels = metas.length - result.matches;
      if (!probeId) probeId = metas.find(meta => !String(meta.id).startsWith('leaf:') && meta.status !== 'upcoming')?.id;
    } else {
      result.catalogError = 'ERR_LEAF_DIAGNOSTIC_CATALOG_STATUS';
    }
  } catch (error) {
    result.catalogError = diagnosticErrorCode(error);
  }

  result.probeSelected = Boolean(probeId);
  if (!probeId) {
    result.verdict = result.catalogError || 'NO_ACTIVE_FIXTURES';
    return result;
  }

  try {
    const response = await safeFetch(`${base}/stream/sport/${encodeURIComponent(probeId)}.json`, jsonOptions);
    result.streamStatus = httpStatus(response);
    if (!response?.ok || response.bodyTruncated) {
      result.verdict = 'ERR_LEAF_DIAGNOSTIC_STREAM_STATUS';
      return result;
    }
    const body = await response.json();
    const streams = Array.isArray(body.streams) ? body.streams : [];
    result.streamEntries = streams.length;
    const urls = streams.filter(stream => {
      try { return stream && validateLeafManifestUrl(stream.url); } catch (_) { return false; }
    });
    result.papacitoUrls = urls.length;
    if (!urls.length) {
      result.verdict = 'NO_MEDIA_URLS';
      return result;
    }
    const playlistUrl = urls[0].url;
    result.unverifiedTokenExpiry = tokenExpiry(playlistUrl);
    const playlistResponse = await safeFetch(playlistUrl, {
      headers: { 'User-Agent': UA, Referer: 'https://sports.highfly.to/', Origin: 'https://sports.highfly.to', Accept: '*/*' },
      timeoutMs: 10000, maxBodyBytes: METADATA_LIMIT, guardExternal: true
    });
    result.playlist = { status: httpStatus(playlistResponse) };
    if (!playlistResponse?.ok || playlistResponse.bodyTruncated) {
      result.verdict = 'ERR_LEAF_DIAGNOSTIC_PLAYLIST_STATUS';
      return result;
    }
    const text = await playlistResponse.text();
    Object.assign(result.playlist, classifyPlaylist(text));
    if (!result.playlist.valid || result.playlist.notice || result.playlist.kind !== 'media' || !result.playlist.segments) {
      result.verdict = !result.playlist.valid ? 'INVALID_PLAYLIST' : result.playlist.notice ? 'NOTICE_PLAYLIST' :
        result.playlist.kind === 'master' ? 'MASTER_PLAYLIST_NOT_PROBED' :
          result.playlist.kind === 'empty' ? 'EMPTY_PLAYLIST' : 'NO_TS_SEGMENTS';
      return result;
    }

    // Resolve relative media paths against the final playlist URL, after any
    // guarded redirect. HEAD checks metadata without fetching segment bodies.
    const first = playlistLines(text).find(isTsSegment);
    let segmentUrl;
    try {
      segmentUrl = new URL(first, playlistResponse.url || playlistUrl);
      if (!['http:', 'https:'].includes(segmentUrl.protocol)) throw new Error('Invalid segment protocol');
    } catch (_) {
      result.verdict = 'ERR_LEAF_DIAGNOSTIC_SEGMENT_URL';
      return result;
    }
    try {
      const segmentResponse = await safeFetch(segmentUrl.toString(), {
        method: 'HEAD', headers: { 'User-Agent': UA, Accept: '*/*' }, timeoutMs: 10000, maxBodyBytes: METADATA_LIMIT, guardExternal: true
      });
      result.segment = { status: httpStatus(segmentResponse) };
      result.ok = Boolean(segmentResponse?.ok && result.segment.status >= 200 && result.segment.status < 300);
      result.verdict = result.ok ? 'METADATA_REACHABLE_PLAYBACK_NOT_RUN' : 'ERR_LEAF_DIAGNOSTIC_SEGMENT_STATUS';
    } catch (error) {
      result.segment = { error: diagnosticErrorCode(error) };
      result.verdict = 'ERR_LEAF_DIAGNOSTIC_SEGMENT_REQUEST';
    }
  } catch (error) {
    result.streamError = diagnosticErrorCode(error);
    result.verdict = 'ERR_LEAF_DIAGNOSTIC_REQUEST';
  }
  return result;
}

module.exports = { safeOrigin, tokenExpiry, diagnosticErrorCode, classifyPlaylist, runLeafDiagnostics };
