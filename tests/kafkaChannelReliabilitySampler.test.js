'use strict';

const http = require('http');
const { parseArgs, parseLoopbackOrigin, requestJsonWithAgent } = require('../scripts/diagnostics/kafka-channel-reliability');

describe('Kafka channel reliability sampler', () => {
  test('keeps its sampler origin on a local HTTP(S) listener', () => {
    expect(parseLoopbackOrigin('http://127.0.0.1:7000').origin).toBe('http://127.0.0.1:7000');
    expect(parseLoopbackOrigin('https://localhost:7443').origin).toBe('https://localhost:7443');
    expect(() => parseLoopbackOrigin('https://nuviosports.xyz')).toThrow('loopback');
    expect(() => parseLoopbackOrigin('http://10.0.0.4:7000')).toThrow('loopback');
    expect(() => parseLoopbackOrigin('http://127.0.0.1:7000/health')).toThrow('path');
  });

  test('bounds sample count before opening loopback sessions', () => {
    expect(parseArgs(['--samples', '99']).samples).toBe(12);
  });

  test('enforces the sampler wall-clock deadline while a loopback listener keeps sending bytes', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const interval = setInterval(() => res.write(' '), 2);
      res.on('close', () => clearInterval(interval));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const agent = new http.Agent({ keepAlive: true });
    try {
      await expect(requestJsonWithAgent(`http://127.0.0.1:${port}/health`, agent, 50)).rejects.toThrow('timed out');
    } finally {
      agent.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
