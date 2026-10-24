module.exports = {
  apps: [
    {
      name: 'nuvio-sports',
      script: 'dist/index.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '1500M',
      node_args: '--expose-gc',
      env: {
        NODE_ENV: 'production',
        MALLOC_ARENA_MAX: '2',
        MALLOC_CONF: 'narenas:2,dirty_decay_ms:5000,muzzy_decay_ms:5000',
        LD_PRELOAD: '/usr/lib/x86_64-linux-gnu/libjemalloc.so.2',
        UV_THREADPOOL_SIZE: '64',
        // The impit native client (Rust) holds pools, TLS sessions and per-host
        // buffers that are never released, and it exposes no close() API; it was
        // measured at ~250 MB/h per instance. Three instances now exist (main,
        // WARP proxy, vanilla) and each recycles on this one clock, so the window
        // - not the request rate - sets the peak. At the 90 min code default with
        // two active instances that is ~750 MB/worker, which is what drove the
        // RSS sawtooth up into the restart ceiling. 10 min caps it near ~85 MB.
        IMPIT_RECYCLE_MS: '240000',
        PREWARM_MAX_MATCHES: '12',
        PREWARM_CRON_SCHEDULE: '*/3 * * * *',
        WARP_PROXY_URL: 'socks5://127.0.0.1:40000',
        // Cloudflare worker-budget counters live in process memory, so each
        // cluster instance must be told how many siblings share the same caps.
        WORKER_INSTANCE_COUNT: '2'
      }
    }
  ]
};
