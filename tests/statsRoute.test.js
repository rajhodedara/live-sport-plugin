'use strict';

const express = require('express');
const http = require('node:http');

const mockGetSummary = jest.fn(() => ({
  dau: 10,
  wau: 25,
  mau: 60,
  stickiness: 0.167,
  byEndpoint: {},
  daily: [],
  updatedAt: '2026-11-25T00:00:00.000Z',
}));

jest.mock('../src/container', () => ({
  resolve: jest.fn((name) => {
    if (name === 'usageStatsService') return { getSummary: mockGetSummary };
    throw new Error(`Unexpected resolve: ${name}`);
  }),
}));

const statsRouter = require('../src/routes/stats');

function requestApp(app, { path = '/api/stats', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          server.close(() => {
            try {
              resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
            } catch (_) {
              resolve({ status: res.statusCode, headers: res.headers, body });
            }
          });
        });
      });
      req.on('error', (err) => server.close(() => reject(err)));
      req.end();
    });
  });
}

describe('GET /api/stats', () => {
  const prevToken = process.env.STATS_TOKEN;
  let app;

  beforeEach(() => {
    delete process.env.STATS_TOKEN;
    mockGetSummary.mockClear();
    app = express();
    app.use(statsRouter);
  });

  afterAll(() => {
    if (prevToken === undefined) delete process.env.STATS_TOKEN;
    else process.env.STATS_TOKEN = prevToken;
  });

  test('denies proxied request when STATS_TOKEN is not configured', async () => {
    const res = await requestApp(app, {
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    });
    expect(res.status).toBe(403);
    expect(mockGetSummary).not.toHaveBeenCalled();
  });

  test('denies proxied request with wrong token', async () => {
    process.env.STATS_TOKEN = 'super-secret-token';
    const res = await requestApp(app, {
      path: '/api/stats?token=wrong',
      headers: { 'cf-connecting-ip': '203.0.113.5' },
    });
    expect(res.status).toBe(403);
    expect(mockGetSummary).not.toHaveBeenCalled();
  });

  test('allows proxied request with valid Bearer token or query token', async () => {
    process.env.STATS_TOKEN = 'super-secret-token';
    const r1 = await requestApp(app, {
      headers: {
        'cf-connecting-ip': '203.0.113.5',
        authorization: 'Bearer super-secret-token',
      },
    });
    expect(r1.status).toBe(200);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(r1.body.dau).toBe(10);

    const r2 = await requestApp(app, {
      path: '/api/stats?token=super-secret-token&days=7',
      headers: { 'x-forwarded-for': '203.0.113.5' },
    });
    expect(r2.status).toBe(200);
    expect(mockGetSummary).toHaveBeenLastCalledWith(expect.any(Date), 7);
  });

  test('allows local direct request without token', async () => {
    const res = await requestApp(app);
    expect(res.status).toBe(200);
    expect(res.body.mau).toBe(60);
  });
});
