const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const FIXTURES_DIR = path.resolve(__dirname, '../../../nuvio-re-lab/fixtures');
const REF_FILE = path.join(FIXTURES_DIR, 'reference_hashes.json');
const OUTPUT_FILE = path.join(FIXTURES_DIR, 'cloudflare_tail_telemetry.json');

const WORKER_BASE = 'https://nuvio-proxy2.rajodedara360.workers.dev';
const WS_URL = 'wss://tail.developers.workers.dev/16d86fe8c21e4e409f798278090a8ed9';
const BENCH_TOKEN = '12345678raj';

function computeSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function percentile(arr, p) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main() {
  console.log('=== Cloudflare Authoritative Tail CPU Benchmark ===');
  console.log(`Worker: ${WORKER_BASE}`);
  console.log(`Tail WebSocket: ${WS_URL}`);

  if (!fs.existsSync(REF_FILE)) {
    console.error('Reference file missing:', REF_FILE);
    process.exit(1);
  }

  const refEntries = JSON.parse(fs.readFileSync(REF_FILE, 'utf8'));
  console.log(`Loaded ${refEntries.length} reference fixtures.`);

  // Connect to Tail WebSocket
  const tailEvents = new Map(); // cf-ray -> event
  const ws = new WebSocket(WS_URL, 'trace-v1');

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('WebSocket Tail connected successfully with trace-v1.');
      resolve();
    });
    ws.on('error', (err) => {
      console.error('WebSocket Tail error:', err);
      reject(err);
    });
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const ray = msg.event?.request?.headers?.['cf-ray'];
      if (ray) {
        // Strip colo suffix if any (e.g., 'a617e79c2c743af5-BOM' -> match base or full)
        const baseRay = ray.split('-')[0];
        tailEvents.set(ray, msg);
        tailEvents.set(baseRay, msg);
      }
    } catch {}
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket Tail closed: ${code} ${reason}`);
  });

  const results = [];

  // Actions to test
  const actions = ['bench_relay', 'bench_inflate', 'bench_decode'];

  for (const entry of refEntries) {
    const filePath = path.join(FIXTURES_DIR, entry.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`Fixture file not found: ${entry.file}`);
      continue;
    }
    const pngBuf = fs.readFileSync(filePath);
    const isStoredOnly = entry.file.includes('BBC');
    console.log(`\nTesting fixture: ${entry.file} (${pngBuf.length} bytes, stored=${isStoredOnly})`);

    const fixtureRecord = {
      file: entry.file,
      pngSize: pngBuf.length,
      isStoredOnly,
      actions: {}
    };

    for (const act of actions) {
      const actRecords = [];
      // 3 iterations: 1 cold + 2 warm
      for (let iter = 0; iter < 3; iter++) {
        const url = `${WORKER_BASE}/?action=${act}`;
        const traceId = `probe_${entry.file}_${act}_${iter}_${Date.now()}`;

        const reqHeaders = {
          'Content-Type': 'image/png',
          'x-bench-token': BENCH_TOKEN,
          'X-Trace-ID': traceId
        };

        const tStart = Date.now();
        let res, resBuf;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: reqHeaders,
            body: pngBuf
          });
          const arrayBuffer = await res.arrayBuffer();
          resBuf = Buffer.from(arrayBuffer);
        } catch (fetchErr) {
          console.error(`  [${act} iter ${iter}] Fetch error:`, fetchErr.message);
          continue;
        }
        const clientWallMs = Date.now() - tStart;
        const cfRayHeader = res.headers.get('cf-ray') || '';
        const baseRay = cfRayHeader.split('-')[0];

        // Wait up to 3 seconds for tail event to arrive
        let tailEvent = tailEvents.get(cfRayHeader) || tailEvents.get(baseRay);
        if (!tailEvent) {
          for (let w = 0; w < 30; w++) {
            await new Promise(r => setTimeout(r, 100));
            tailEvent = tailEvents.get(cfRayHeader) || tailEvents.get(baseRay);
            if (tailEvent) break;
          }
        }

        const cfCpuMs = tailEvent ? tailEvent.cpuTime : null;
        const cfWallMs = tailEvent ? tailEvent.wallTime : null;
        const cfOutcome = tailEvent ? tailEvent.outcome : 'unknown';

        let parity = null;
        let outputHash = null;
        if (act === 'bench_decode' && res.status === 200) {
          outputHash = computeSha256(resBuf);
          parity = (outputHash === entry.tsSha256);
          if (!parity) {
            console.error(`  [MISMATCH] ${entry.file}: expected ${entry.tsSha256}, got ${outputHash}`);
          }
        }

        console.log(`  [${act} #${iter + 1}] status=${res.status} cfCpuMs=${cfCpuMs} cfWallMs=${cfWallMs} outcome=${cfOutcome} clientWall=${clientWallMs}ms ray=${cfRayHeader} parity=${parity !== null ? (parity ? 'PASS' : 'FAIL') : 'N/A'}`);

        actRecords.push({
          iter,
          status: res.status,
          cfRay: cfRayHeader,
          cfCpuMs,
          cfWallMs,
          cfOutcome,
          clientWallMs,
          outputHash,
          parity
        });

        // Small pacing delay between requests
        await new Promise(r => setTimeout(r, 400));
      }

      const validCpus = actRecords.map(r => r.cfCpuMs).filter(c => typeof c === 'number');
      fixtureRecord.actions[act] = {
        runs: actRecords,
        p50CpuMs: percentile(validCpus, 50),
        p95CpuMs: percentile(validCpus, 95),
        p99CpuMs: percentile(validCpus, 99)
      };
    }

    results.push(fixtureRecord);
  }

  // Summary aggregation
  const allDecodeCpus = [];
  const storedDecodeCpus = [];
  const dynamicDecodeCpus = [];

  for (const r of results) {
    const runs = r.actions['bench_decode']?.runs || [];
    for (const run of runs) {
      if (typeof run.cfCpuMs === 'number') {
        allDecodeCpus.push(run.cfCpuMs);
        if (r.isStoredOnly) {
          storedDecodeCpus.push(run.cfCpuMs);
        } else {
          dynamicDecodeCpus.push(run.cfCpuMs);
        }
      }
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    worker: WORKER_BASE,
    totalFixtures: results.length,
    overallDecode: {
      samples: allDecodeCpus.length,
      p50CpuMs: percentile(allDecodeCpus, 50),
      p95CpuMs: percentile(allDecodeCpus, 95),
      p99CpuMs: percentile(allDecodeCpus, 99)
    },
    storedOnlyDecode: {
      samples: storedDecodeCpus.length,
      p50CpuMs: percentile(storedDecodeCpus, 50),
      p95CpuMs: percentile(storedDecodeCpus, 95),
      p99CpuMs: percentile(storedDecodeCpus, 99)
    },
    dynamicHuffmanDecode: {
      samples: dynamicDecodeCpus.length,
      p50CpuMs: percentile(dynamicDecodeCpus, 50),
      p95CpuMs: percentile(dynamicDecodeCpus, 95),
      p99CpuMs: percentile(dynamicDecodeCpus, 99)
    },
    fixtures: results
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(summary, null, 2));
  console.log(`\n=== RESULTS WRITTEN TO ${OUTPUT_FILE} ===`);
  console.log('Summary:', JSON.stringify(summary.overallDecode, null, 2));
  console.log('Stored-only Summary:', JSON.stringify(summary.storedOnlyDecode, null, 2));
  console.log('Dynamic Huffman Summary:', JSON.stringify(summary.dynamicHuffmanDecode, null, 2));

  ws.close();
}

main().catch(console.error);
