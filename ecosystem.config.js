module.exports = {
  apps: [
    {
      name: 'nuvio-sports',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      // 1.5 GB is the settled ceiling (owner decision, 2026-10-26). Observed
      // peak RSS is 844 MB and the running process was already started with
      // 1.5 GB while this file still said 1300M - so a plain reload from this
      // file would have lowered the ceiling under live peak usage. Aligned
      // here so that can no longer happen. Do not lower it again.
      max_memory_restart: '1500M',
      node_args: '--expose-gc',
      env: {
        NODE_ENV: 'production',
        // ICU reads this before a worker starts; prepare and verify this directory
        // in the candidate checkout before an operator chooses to reload PM2.
        ICU_TIMEZONE_FILES_DIR: process.env.ICU_TIMEZONE_FILES_DIR ||
          require('node:path').join(__dirname, '.timezone-data', '2026f-le'),
        // ncc rewrites path.join(process.cwd(), 'data') at build time and drops
        // the "data" segment, so a bundle always resolves its cache to
        // <bundle dir>/matches_cache.json (i.e. dist/) regardless of the source.
        // Env is read at runtime, so this is the only way to pin the live cache
        // outside dist/. Refresh data/matches_cache.json from the old dist/ file
        // BEFORE the first reload that carries this var: a stale file means the
        // workers serve an old catalog, a missing one means an empty catalog,
        // until the next sync lands.
        MATCHES_CACHE_PATH: '/root/nuvio-live-sports/data/matches_cache.json',
        MALLOC_ARENA_MAX: '2',
        MALLOC_CONF: 'narenas:2,dirty_decay_ms:5000,muzzy_decay_ms:5000',
        LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2',
        UV_THREADPOOL_SIZE: '16',
        // The impit native client (Rust) holds pools, TLS sessions and per-host
        // buffers that are never released, and it exposes no close() API; it was
        // measured at ~250 MB/h per instance. Three instances now exist (main,
        // WARP proxy, vanilla) and each recycles on this one clock, so the window
        // - not the request rate - sets the peak. At the 90 min code default with
        // two active instances that is ~750 MB/worker, which is what drove the
        // RSS sawtooth up into the restart ceiling. 10 min caps it near ~85 MB.
        // Runs at 240000 today: the 10 min value in this file was never applied
        // (the process predates the edit, same drift as max_memory_restart).
        // Pinned to the observed value so the cache-path cutover changes exactly
        // one thing at runtime - widening this window is a memory decision, not
        // something that should happen as a side effect of a reload.
        IMPIT_RECYCLE_MS: '240000',
        PREWARM_MAX_MATCHES: '12',
        PREWARM_CRON_SCHEDULE: '*/3 * * * *',
        WARP_PROXY_URL: 'socks5://127.0.0.1:40000',
        // Cloudflare worker-budget counters live in process memory, so each
        // cluster instance must be told how many siblings share the same caps.
        WORKER_INSTANCE_COUNT: '2',
        ENABLE_SPEED_PROBE: 'false'
      }
    }
  ]
};
