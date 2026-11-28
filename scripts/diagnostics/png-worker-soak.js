'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKER_URL = process.env.WORKER_URL || 'https://nuvio-proxy.odedararaj456.workers.dev';
const BENCHMARK_TOKEN = process.env.BENCHMARK_TOKEN || process.env.BENCH_SECRET || '';

function percentile(arr, p) {
  if (!arr || !arr.length) return null;
  const valid = arr.filter(v => typeof v === 'number' && !isNaN(v));
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

async function postWorker(action, buffer, timeoutMs = 20000) {
  const url = `${WORKER_URL}/?action=${action}`;
  const t0 = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'Content-Type': 'application/octet-stream',
    'User-Agent': 'NuvioBenchSoak/2.0'
  };
  if (BENCHMARK_TOKEN) {
    headers['x-bench-token'] = BENCHMARK_TOKEN;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: buffer,
      signal: controller.signal
    });
    clearTimeout(timeout);
    const wallMs = performance.now() - t0;

    const status = res.status;
    const cfRay = res.headers.get('cf-ray') || 'missing_ray';

    // Cloudflare Workers internal execution telemetry (only present via Tail / Trace events)
    // performance.now() inside worker is disabled to prevent Spectre / inaccurate measurements.
    const cloudflareCpuMs = null; // Unsampled directly from response headers

    if (!res.ok) {
      const errText = await res.text();
      let outcome = `http_${status}`;
      if (errText.includes('1102') || status === 530) {
        // HTTP 1102 does not differentiate exceededCpu from exceededMemory on client side
        outcome = 'resource_limit_1102 (undifferentiated: exceededCpu or exceededMemory without Cloudflare Trace)';
      }
      return {
        ok: false,
        status,
        cfRay,
        outcome,
        errText: errText.slice(0, 300),
        wallMs,
        cloudflareCpuMs
      };
    }

    const bodyBuf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status,
      cfRay,
      outcome: 'success',
      bodyBuf,
      wallMs,
      cloudflareCpuMs
    };
  } catch (err) {
    clearTimeout(timeout);
    const wallMs = performance.now() - t0;
    return {
      ok: false,
      status: 0,
      cfRay: 'network_error',
      outcome: err.name === 'AbortError' ? 'timeout' : `error: ${err.message}`,
      errText: err.message,
      wallMs,
      cloudflareCpuMs: null
    };
  }
}

async function runBenchmark(fixturesDir, refHashes) {
  console.log(`\n======================================================`);
  console.log(`RUNNING SECURED FREE WORKER BENCHMARK: ${WORKER_URL}`);
  console.log(`Benchmark Token: ${BENCHMARK_TOKEN ? '[PROVIDED]' : '[NOT SET - Expect 403]'}`);
  console.log(`Operations: bench_relay, bench_inflate, bench_decode`);
  console.log(`======================================================\n`);

  const results = {
    metadata: {
      workerUrl: WORKER_URL,
      timestamp: new Date().toISOString(),
      note: 'Worker CPU values are set to null when Cloudflare Trace / Tail telemetry is absent. Never estimated from wall-clock.'
    },
    relay: {},
    inflate: {},
    decode: {}
  };

  const ops = ['bench_relay', 'bench_inflate', 'bench_decode'];

  for (const ref of refHashes) {
    const pngPath = path.join(fixturesDir, ref.file);
    const pngBuf = fs.readFileSync(pngPath);
    console.log(`--- Fixture: ${ref.file} (${(pngBuf.length / 1024 / 1024).toFixed(2)} MB) ---`);

    for (const op of ops) {
      const stage = op.replace('bench_', '');
      const iterations = 5; // 1 cold + 4 warm
      const wallTimes = [];
      const cpuTimes = [];
      const cfRays = [];
      let lastOutcome = 'unknown';
      let lastStatus = 0;
      let hashMatch = true;

      for (let i = 0; i < iterations; i++) {
        const isCold = (i === 0);
        const res = await postWorker(op, pngBuf);
        lastOutcome = res.outcome;
        lastStatus = res.status;
        cfRays.push(res.cfRay);

        if (!res.ok) {
          console.error(`  [${stage}] iter ${i + 1} (${isCold ? 'cold' : 'warm'}): FAILED - ${res.outcome} [Ray: ${res.cfRay}]`);
          hashMatch = false;
          break;
        }

        wallTimes.push(res.wallMs);
        if (res.cloudflareCpuMs !== null) {
          cpuTimes.push(res.cloudflareCpuMs);
        }

        if (stage === 'decode') {
          const hash = crypto.createHash('sha256').update(res.bodyBuf).digest('hex');
          if (hash !== ref.tsSha256 || res.bodyBuf.length !== ref.tsSize) {
            console.error(`  [decode] iter ${i + 1}: HASH MISMATCH! Got ${hash.slice(0, 12)}, exp ${ref.tsSha256.slice(0, 12)}`);
            hashMatch = false;
          }
        }
      }

      const p50 = percentile(cpuTimes, 50);
      const p95 = percentile(cpuTimes, 95);
      const p99 = percentile(cpuTimes, 99);
      const coldCpu = cpuTimes.length > 0 ? cpuTimes[0] : null;

      results[stage][ref.file] = {
        size: pngBuf.length,
        httpStatus: lastStatus,
        cfRays,
        outcome: lastOutcome,
        hashMatch,
        cloudflare: {
          cpu_time_ms_cold: coldCpu,
          cpu_time_ms_p50: p50,
          cpu_time_ms_p95: p95,
          cpu_time_ms_p99: p99,
          wall_time_ms_avg: wallTimes.length ? wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length : null
        }
      };

      console.log(`  ${stage.toUpperCase().padEnd(8)}: outcome=${lastOutcome} | http=${lastStatus} | wallAvg=${results[stage][ref.file].cloudflare.wall_time_ms_avg ? results[stage][ref.file].cloudflare.wall_time_ms_avg.toFixed(1) + 'ms' : 'N/A'} | cpuTelemetry=${p50 !== null ? p50.toFixed(2) + 'ms' : 'null'} | hash=${hashMatch ? 'OK' : 'MISMATCH'}`);
    }
    console.log('');
  }

  return results;
}

async function runSoak(fixturesDir, refHashes, durationSec = 1800, intervalMs = 2000) {
  console.log(`\n======================================================`);
  console.log(`STARTING LIVE CADENCE SOAK: ${WORKER_URL}`);
  console.log(`Target Duration: ${durationSec}s | Cadence: 1 segment every ${intervalMs}ms`);
  console.log(`======================================================\n`);

  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;
  let segIndex = 0;
  let successCount = 0;
  let failCount = 0;
  const history = [];
  const failures = [];

  while (Date.now() < endTime) {
    segIndex++;
    const ref = refHashes[(segIndex - 1) % refHashes.length];
    const pngPath = path.join(fixturesDir, ref.file);
    const pngBuf = fs.readFileSync(pngPath);

    const segStart = performance.now();
    const res = await postWorker('bench_decode', pngBuf);
    const segDuration = performance.now() - segStart;

    if (!res.ok) {
      failCount++;
      failures.push({
        segIndex,
        file: ref.file,
        status: res.status,
        cfRay: res.cfRay,
        outcome: res.outcome,
        errText: res.errText
      });
      console.error(`[FAIL] Seg #${segIndex} (${ref.file}): status=${res.status} [Ray: ${res.cfRay}] outcome=${res.outcome}`);
      // If circuit breaker / resource limit encountered, stop soak cleanly
      if (res.outcome.includes('1102') || res.status === 530 || res.status === 503) {
        console.error(`[SOAK STOPPED] Edge resource limit encountered at segment ${segIndex}. Stopping soak per test criteria.`);
        break;
      }
    } else {
      const hash = crypto.createHash('sha256').update(res.bodyBuf).digest('hex');
      const hashOk = (hash === ref.tsSha256);
      if (!hashOk) {
        failCount++;
        failures.push({ segIndex, file: ref.file, cfRay: res.cfRay, outcome: 'hash_mismatch' });
        console.error(`[FAIL] Seg #${segIndex} (${ref.file}): HASH MISMATCH [Ray: ${res.cfRay}]`);
      } else {
        successCount++;
        history.push({
          segIndex,
          file: ref.file,
          cfRay: res.cfRay,
          wallMs: res.wallMs
        });
        if (segIndex % 10 === 0 || segIndex <= 5) {
          const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
          console.log(`[SOAK] Seg #${segIndex} (${ref.file}) | elapsed: ${elapsedSec}s/${durationSec}s | wall: ${res.wallMs.toFixed(0)}ms | ray: ${res.cfRay} | hash: OK`);
        }
      }
    }

    const waitMs = Math.max(0, intervalMs - segDuration);
    if (Date.now() + waitMs < endTime) {
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const actualDurationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const isComplete = (Date.now() >= endTime);

  console.log(`\n======================================================`);
  console.log(`SOAK RUN SUMMARY`);
  console.log(`Status:         ${isComplete ? 'COMPLETED FULL 30 MINUTES' : 'STOPPED EARLY'}`);
  console.log(`Run duration:   ${actualDurationSec}s / ${durationSec}s`);
  console.log(`Total segments: ${segIndex}`);
  console.log(`Successful:     ${successCount}`);
  console.log(`Failed:         ${failCount}`);
  console.log(`======================================================\n`);

  return {
    isComplete,
    actualDurationSec: Number(actualDurationSec),
    targetDurationSec: durationSec,
    totalSegments: segIndex,
    successCount,
    failCount,
    failures
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isSoak = args.includes('--soak');
  const durationArg = args.find(a => a.startsWith('--duration='));
  const durationSec = durationArg ? parseInt(durationArg.split('=')[1], 10) : 1800;

  const fixturesDir = path.resolve(__dirname, '../../../nuvio-re-lab/fixtures');
  const refHashes = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'reference_hashes.json'), 'utf8'));

  if (isSoak) {
    const soakRes = await runSoak(fixturesDir, refHashes, durationSec);
    fs.writeFileSync(path.join(fixturesDir, 'soak_results.json'), JSON.stringify(soakRes, null, 2));
  } else {
    const benchRes = await runBenchmark(fixturesDir, refHashes);
    fs.writeFileSync(path.join(fixturesDir, 'bench_results.json'), JSON.stringify(benchRes, null, 2));
  }
}

main().catch(err => {
  console.error('Fatal benchmark error:', err);
  process.exit(1);
});
