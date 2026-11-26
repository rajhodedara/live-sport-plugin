#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const { safeFetch, streamingFetch } = require('../../src/services/ProviderOutbound');

const MAX_SAMPLES = 12;
const DEFAULT_SAMPLES = 6;
const MAX_CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 22000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function parseLoopbackOrigin(value) {
  const origin = new URL(value);
  const hostname = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
    throw new TypeError('Origin must be an HTTP(S) loopback address');
  }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new TypeError('Origin must not include credentials, a path, query, or fragment');
  }
  return origin;
}

function parseArgs(argv) {
  const args = {
    origin: 'http://127.0.0.1:7000',
    id: 'nuvio_sport_cdn_ch_xx_sky-sports-f1',
    samples: DEFAULT_SAMPLES,
    sources: 'kafka',
    probeIds: ''
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--origin' && next) { args.origin = next; i += 1; }
    else if (key === '--id' && next) { args.id = next; i += 1; }
    else if (key === '--samples' && next) {
      const n = Number.parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) args.samples = Math.min(MAX_SAMPLES, n);
      i += 1;
    }
    else if (key === '--sources' && next) { args.sources = next; i += 1; }
    else if (key === '--probe-ids' && next) { args.probeIds = next; i += 1; }
  }
  return args;
}

function requestJsonWithAgent(urlString, agent) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', agent, timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          res.destroy();
          finish(reject, new RangeError('Response exceeds sampler limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          finish(resolve, { status: res.statusCode || 0, json: JSON.parse(text) });
        } catch (_) {
          finish(resolve, { status: res.statusCode || 0, json: null });
        }
      });
      res.on('error', (err) => finish(reject, err));
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function extractCandidateIds(streams) {
  if (!Array.isArray(streams)) return [];
  const ids = [];
  for (const s of streams) {
    if (!s || typeof s !== 'object') continue;
    if (s._kafkaCandidateId) {
      ids.push(String(s._kafkaCandidateId));
    } else if (typeof s.url === 'string' && s.url.includes('cacheKey=')) {
      try {
        const u = new URL(s.url, 'http://localhost');
        const ck = u.searchParams.get('cacheKey') || '';
        const parts = ck.split(':');
        if (parts.length >= 3) ids.push(parts.slice(2).join(':'));
      } catch (_) {}
    } else if (s.title) {
      ids.push(String(s.title).split('\n')[0].slice(0, 48));
    }
  }
  return ids;
}

function diffWorkerCache(beforeHealth, afterHealth) {
  const b = beforeHealth?.resolveCache || {};
  const a = afterHealth?.resolveCache || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    scope: 'worker-wide',
    entries: num(a.entries),
    inFlight: num(a.inFlight),
    hitsDelta: num(a.hits) - num(b.hits),
    missesDelta: num(a.misses) - num(b.misses),
    negativeHitsDelta: num(a.negativeHits) - num(b.negativeHits),
    deferredHitsDelta: num(a.deferredHits) - num(b.deferredHits),
    deferralsDelta: num(a.deferrals) - num(b.deferrals),
    evictionsDelta: num(a.evictions) - num(b.evictions)
  };
}

async function runSample(idx, args, streamPath) {
  const agent = (args.origin.startsWith('https:') ? https : http).Agent({ keepAlive: true, maxSockets: 1 });
  const startedAt = Date.now();
  try {
    const before = await requestJsonWithAgent(`${args.origin}/health`, agent).catch(() => ({ status: 0, json: null }));
    const streamRes = await requestJsonWithAgent(`${args.origin}${streamPath}`, agent);
    const after = await requestJsonWithAgent(`${args.origin}/health`, agent).catch(() => ({ status: 0, json: null }));
    const body = streamRes.json || {};
    const streams = Array.isArray(body.streams) ? body.streams : [];
    const beforePid = before.json?.pid ?? null;
    const afterPid = after.json?.pid ?? null;
    return {
      sample: idx + 1,
      beforePid,
      afterPid,
      sameWorker: beforePid !== null && beforePid === afterPid,
      status: streamRes.status,
      elapsedMs: Date.now() - startedAt,
      streamCount: streams.length,
      returnedCandidateIds: extractCandidateIds(streams),
      cacheMaxAge: body.cacheMaxAge ?? null,
      workerWideCacheDeltas: diffWorkerCache(before.json, after.json)
    };
  } catch (err) {
    return {
      sample: idx + 1,
      beforePid: null,
      afterPid: null,
      sameWorker: false,
      status: 0,
      elapsedMs: Date.now() - startedAt,
      errorKind: err?.name || 'Error',
      streamCount: 0,
      returnedCandidateIds: [],
      cacheMaxAge: null,
      workerWideCacheDeltas: null
    };
  } finally {
    agent.destroy();
  }
}

async function probeUpstreamId(manifestBase, candidateId) {
  const startedAt = Date.now();
  try {
    const res = await safeFetch(`${manifestBase}/stream/tv/${encodeURIComponent(candidateId)}.json`, {
      timeoutMs: 8000,
      maxBodyBytes: 256 * 1024,
      diagnosticOwner: 'kafka_sampler_probe'
    });
    if (!res || !res.ok) {
      return { candidateId, ok: false, stage: 'resolve', status: res?.status || 0, elapsedMs: Date.now() - startedAt };
    }
    const data = await res.json();
    const first = Array.isArray(data?.streams) ? data.streams.find(s => s && typeof s.url === 'string') : null;
    if (!first) {
      return { candidateId, ok: false, stage: 'resolve', status: 200, reason: 'empty', elapsedMs: Date.now() - startedAt };
    }
    const pl = await safeFetch(first.url, { timeoutMs: 8000, maxBodyBytes: 256 * 1024, diagnosticOwner: 'kafka_sampler_probe' });
    if (!pl || !pl.ok) {
      return { candidateId, ok: false, stage: 'playlist', status: pl?.status || 0, elapsedMs: Date.now() - startedAt };
    }
    const text = await pl.text();
    const segLine = text.split(/\r?\n/).find(l => l.trim() && !l.trim().startsWith('#'));
    if (!segLine) {
      return { candidateId, ok: false, stage: 'playlist', status: 200, reason: 'no_segment', elapsedMs: Date.now() - startedAt };
    }
    const segUrl = new URL(segLine.trim(), first.url).toString();
    const segRes = await streamingFetch(segUrl, { timeoutMs: 8000, diagnosticOwner: 'kafka_sampler_probe' });
    let bytes = 0;
    if (segRes?.body?.getReader) {
      const reader = segRes.body.getReader();
      try {
        const chunk = await reader.read();
        bytes = chunk?.value?.byteLength || 0;
      } finally {
        try { await reader.cancel(); } catch (_) {}
      }
    }
    return { candidateId, ok: Boolean(segRes?.ok && bytes > 0), stage: 'segment', status: segRes?.status || 0, sampleBytes: bytes, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    return { candidateId, ok: false, stage: 'probe', errorKind: err?.name || 'Error', elapsedMs: Date.now() - startedAt };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const originUrl = parseLoopbackOrigin(args.origin);
  const configSeg = Buffer.from(JSON.stringify({ liveSources: args.sources })).toString('base64url');
  const streamPath = `/${configSeg}/stream/tv/${encodeURIComponent(args.id)}.json`;

  const results = new Array(args.samples);
  let nextIdx = 0;
  const workerCount = Math.min(MAX_CONCURRENCY, args.samples);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIdx < args.samples) {
      const idx = nextIdx++;
      results[idx] = await runSample(idx, { ...args, origin: originUrl.origin }, streamPath);
    }
  }));

  let upstreamProbes = null;
  if (args.probeIds && process.env.KAFKA_MANIFEST_URL) {
    const base = process.env.KAFKA_MANIFEST_URL.replace(/\/manifest\.json$/, '');
    const ids = args.probeIds.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
    upstreamProbes = [];
    for (const cid of ids) {
      upstreamProbes.push(await probeUpstreamId(base, cid));
    }
  }

  process.stdout.write(JSON.stringify({
    origin: originUrl.origin,
    id: args.id,
    sources: args.sources,
    samplesRequested: args.samples,
    results,
    ...(upstreamProbes ? { upstreamProbes } : {})
  }, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Sampler failed: ${err?.name || 'Error'}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, parseLoopbackOrigin, extractCandidateIds, diffWorkerCache };
