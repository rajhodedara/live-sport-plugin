'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const http = require('node:http');
const container = require('../src/container');
const UsageStatsService = require('../src/services/UsageStatsService');

describe('UsageStatsService container & middleware integration', () => {
  test('container resolves usageStatsService as a singleton UsageStatsService', () => {
    const first = container.resolve('usageStatsService');
    const second = container.resolve('usageStatsService');
    expect(first).toBeInstanceOf(UsageStatsService);
    expect(second).toBe(first);
    first.close();
  });

  test('Express middleware records addon requests without blocking response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-stats-int-'));
    const dbPath = path.join(dir, 'usage_stats.sqlite');
    const tracker = new UsageStatsService({ dbPath, salt: 'int-salt', flushIntervalMs: 0 });

    const app = express();
    app.use((req, _res, next) => {
      tracker.recordRequest(req);
      next();
    });
    app.get('/manifest.json', (_req, res) => res.json({ ok: true }));
    app.get('/stream/tv/123.json', (_req, res) => res.json({ streams: [] }));

    await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        http.get({ host: '127.0.0.1', port, path: '/manifest.json', headers: { 'cf-connecting-ip': '203.0.113.9' } }, (r1) => {
          r1.resume();
          r1.on('end', () => {
            http.get({ host: '127.0.0.1', port, path: '/stream/tv/123.json', headers: { 'cf-connecting-ip': '203.0.113.9' } }, (r2) => {
              r2.resume();
              r2.on('end', () => server.close(resolve));
            }).on('error', reject);
          });
        }).on('error', reject);
      });
    });

    const summary = tracker.getSummary();
    expect(summary.dau).toBe(1);
    expect(summary.byEndpoint.manifest.hitsToday).toBe(1);
    expect(summary.byEndpoint.stream.hitsToday).toBe(1);

    tracker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
