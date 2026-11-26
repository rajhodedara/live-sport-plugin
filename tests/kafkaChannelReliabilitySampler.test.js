'use strict';

const { parseArgs, parseLoopbackOrigin } = require('../scripts/diagnostics/kafka-channel-reliability');

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
});
