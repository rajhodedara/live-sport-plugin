'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WORKER_URL = process.env.WORKER_URL || 'https://nuvio-proxy.odedararaj456.workers.dev';

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

async function postWorker(action, buffer, timeoutMs = 15000) {
  const url = `${WORKER_URL}/?action=${action}`;
  const t0 = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'NuvioBenchSoak/1.0'
      },
      body: buffer,
      signal: controller.signal
    });
    clearTimeout(timeout);
    const wallMs = performance.now() - t0;

    const status = res.status;
    const decodeHeader = res.headers.get('x-decode-time-ms');
    const inflateHeader = res.headers.get('x-inflate-time-ms');
    const relayHeader = res.headers.get('x-relay-time-ms');
    const serverTiming = res.headers.get('server-timing') || '';

    const workerCpuMs = decodeHeader ? parseFloat(decodeHeader) :
                        (inflateHeader ? parseFloat(inflateHeader) :
                        (relayHeader ? parseFloat(relayHeader) : null));

    if (!res.ok) {
      const errText = await res.text();
      let outcome = `HTTP ${status}`;
      if (errText.includes('1102') || status === 530) {
        outcome = errText.includes('memory') ? 'exceededMemory (1102)' : 'exceededCpu (1102)';
      }
      return { ok: false, status, outcome, errText, wallMs, workerCpuMs };
    }

    const bodyBuf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status,
      outcome: 'success',
      bodyBuf,
      wallMs,
      workerCpuMs,
      serverTiming
    };
  } catch (err) {
    clearTimeout(timeout);
    const wallMs = performance.now() - t0;
    return {
      ok: false,
      status: 0,
      outcome: err.name === 'AbortError' ? 'timeout' : err.message,
      errText: err.message,
      wallMs,
      workerCpuMs: null
    };
  }
}

async function runBenchmark(fixturesDir, refHashes) {
  console.log(`\n======================================================`);
  console.log(`RUNNING ISOLATED FREE WORKER BENCHMARK: ${WORKER_URL}`);
  console.log(`Operations: bench_relay, bench_inflate, bench_decode`);
  console.log(`======================================================\n`);

  const results = {
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
      const cpuTimes = [];
      const wallTimes = [];
      let lastOutcome = 'unknown';
      let hashMatch = true;

      for (let i = 0; i < iterations; i++) {
        const isCold = (i === 0);
        const res = await postWorker(op, pngBuf);
        lastOutcome = res.outcome;

        if (!res.ok) {
          console.error(`  [${stage}] iter ${i + 1} (${isCold ? 'cold' : 'warm'}): FAILED - ${res.outcome}`);
          hashMatch = false;
          break;
        }

        const cpu = res.workerCpuMs !== null ? res.workerCpuMs : 0;
        cpuTimes.push(cpu);
        wallTimes.push(res.wallMs);

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
      const coldCpu = cpuTimes[0] !== undefined ? cpuTimes[0] : 0;

      results[stage][ref.file] = {
        size: pngBuf.length,
        outcome: lastOutcome,
        hashMatch,
        coldCpu,
        p50,
        p95,
        p99,
        wallAvg: wallTimes.length ? wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length : 0
      };

      console.log(`  ${stage.toUpperCase().padEnd(8)}: outcome=${lastOutcome} | cold=${coldCpu.toFixed(2)}ms | p50=${p50.toFixed(2)}ms | p95=${p95.toFixed(2)}ms | p99=${p99.toFixed(2)}ms | hash=${hashMatch ? 'OK' : 'MISMATCH'}`);
    }
    console.log('');
  }

  return results;
}

async function runSoak(fixturesDir, refHashes, durationSec = 1800, intervalMs = 2000) {
  console.log(`\n======================================================`);
  console.log(`RUNNING 30-MINUTE LIVE CADENCE SOAK: ${WORKER_URL}`);
  console.log(`Duration: ${durationSec}s | Cadence: 1 segment every ${intervalMs}ms`);
  console.log(`======================================================\n`);

  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;
  let segIndex = 0;
  let successCount = 0;
  let failCount = 0;
  const cpuHistory = [];
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
      failures.push({ segIndex, file: ref.file, outcome: res.outcome, err: res.errText });
      console.error(`[FAIL] Seg #${segIndex} (${ref.file}): ${res.outcome}`);
    } else {
      const hash = crypto.createHash('sha256').update(res.bodyBuf).digest('hex');
      const hashOk = (hash === ref.tsSha256);
      if (!hashOk) {
        failCount++;
        failures.push({ segIndex, file: ref.file, outcome: 'hash_mismatch' });
        console.error(`[FAIL] Seg #${segIndex} (${ref.file}): HASH MISMATCH`);
      } else {
        successCount++;
        const cpu = res.workerCpuMs !== null ? res.workerCpuMs : 0;
        cpuHistory.push(cpu);
        if (segIndex % 10 === 0 || segIndex <= 5) {
          const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
          console.log(`[SOAK] Seg #${segIndex} (${ref.file}) | elapsed: ${elapsedSec}s/${durationSec}s | workerCpu: ${cpu.toFixed(2)}ms | wall: ${res.wallMs.toFixed(0)}ms | hash: OK`);
        }
      }
    }

    const waitMs = Math.max(0, intervalMs - segDuration);
    if (Date.now() + waitMs < endTime) {
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const p50 = percentile(cpuHistory, 50);
  const p95 = percentile(cpuHistory, 95);
  const p99 = percentile(cpuHistory, 99);

  console.log(`\n======================================================`);
  console.log(`SOAK COMPLETED`);
  console.log(`Total segments: ${segIndex}`);
  console.log(`Successful:     ${successCount}`);
  console.log(`Failed:         ${failCount}`);
  console.log(`CPU p50:        ${p50.toFixed(2)} ms`);
  console.log(`CPU p95:        ${p95.toFixed(2)} ms`);
  console.log(`CPU p99:        ${p99.toFixed(2)} ms`);
  console.log(`======================================================\n`);

  return {
    totalSegments: segIndex,
    successCount,
    failCount,
    p50,
    p95,
    p99,
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
