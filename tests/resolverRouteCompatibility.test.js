const http = require('http');
const express = require('express');
jest.mock('../src/services/OutboundUrlGuard', () => ({
  checkOutboundUrl: async url => ({ ok: url === 'https://fixture.invalid/video' }),
  rejectBlockedUrl: res => res.status(403).send('fixture blocked')
}));
const streamRouter = require('../src/routes/streamProxy');
const watchRouter = require('../src/routes/watch');
let server, port;
const originalFetch = global.fetch;
beforeAll(async () => {
  const app = express(); app.use(streamRouter); app.use(watchRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  global.fetch = jest.fn(async () => new Response('media-fixture', { headers: { 'content-type': 'video/mp4' } }));
});
afterAll(async () => {
  global.fetch = originalFetch;
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
});
function request(route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture timeout')));
  });
}
test.each(['/api/fastmp4', '/api/mp4proxy', '/api/hlschunk'])('%s preserves missing-input response', async route => {
  const result = await request(route); expect(result.status).toBe(400); expect(result.body).toContain('Missing');
});
test('/watch preserves missing extraction input response', async () => {
  const result = await request('/watch?mode=extract'); expect(result.status).toBe(400); expect(result.body).toBe('Missing ?embed parameter');
});
test('/watch preserves protocol rejection', async () => {
  const result = await request('/watch?mode=extract&embed=javascript%3Aalert(1)'); expect(result.status).toBe(400); expect(result.body).toBe('Invalid embed URL protocol');
});
test('/watch serves extraction HTML and escapes its title', async () => {
  const result = await request('/watch?' + new URLSearchParams({ mode: 'extract', embed: 'https://fixture.invalid/embed', title: '<Match>' }));
  expect(result.status).toBe(200); expect(result.headers['content-type']).toContain('text/html');
  expect(result.body).toContain('&lt;Match&gt;'); expect(result.body).toContain('/api/proxy-embed');
});
test('/watch preserves YouTube redirect without visiting YouTube', async () => {
  const result = await request('/watch?ytId=abcdefghijk'); expect(result.status).toBe(302); expect(result.headers.location).toBe('https://www.youtube.com/watch?v=abcdefghijk');
});
test('passthrough preserves media bytes and status', async () => {
  const result = await request('/api/mp4proxy?url=https%3A%2F%2Ffixture.invalid%2Fvideo');
  expect(result.status).toBe(200); expect(result.body).toBe('media-fixture'); expect(result.headers['content-type']).toBe('video/mp4');
});
test('blocked target remains rejected before fetching', async () => {
  global.fetch.mockClear(); const result = await request('/api/mp4proxy?url=https%3A%2F%2Fblocked.invalid');
  expect(result.status).toBe(403); expect(global.fetch).not.toHaveBeenCalled();
});
