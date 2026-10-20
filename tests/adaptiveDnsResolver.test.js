'use strict';

const { AdaptiveDnsResolver } = require('../src/services/AdaptiveDnsResolver');
const dns = require('node:dns');

describe('AdaptiveDnsResolver & Anti-Censorship Circuit Breaker', () => {
  let resolver;

  beforeEach(() => {
    resolver = new AdaptiveDnsResolver({
      circuitResetMs: 1000, // 1s for fast test resets
      cacheTtlMs: 500,
      maxEntries: 10
    });
  });

  describe('isLocalOrReserved', () => {
    test('correctly identifies localhost and local dev environments', () => {
      expect(resolver.isLocalOrReserved('localhost')).toBe(true);
      expect(resolver.isLocalOrReserved('my-app.localhost')).toBe(true);
      expect(resolver.isLocalOrReserved('api.local')).toBe(true);
      expect(resolver.isLocalOrReserved('cluster.internal')).toBe(true);
    });

    test('correctly identifies IP literals as reserved', () => {
      expect(resolver.isLocalOrReserved('127.0.0.1')).toBe(true);
      expect(resolver.isLocalOrReserved('192.168.1.10')).toBe(true);
      expect(resolver.isLocalOrReserved('::1')).toBe(true);
      expect(resolver.isLocalOrReserved('fe80::1')).toBe(true);
    });

    test('identifies public external hostnames as not local', () => {
      expect(resolver.isLocalOrReserved('dlive.sx')).toBe(false);
      expect(resolver.isLocalOrReserved('fullraces.com')).toBe(false);
      expect(resolver.isLocalOrReserved('streamed.pk')).toBe(false);
      expect(resolver.isLocalOrReserved('google.com')).toBe(false);
    });

    test('handles null, undefined and invalid types safely', () => {
      expect(resolver.isLocalOrReserved(null)).toBe(true);
      expect(resolver.isLocalOrReserved(undefined)).toBe(true);
      expect(resolver.isLocalOrReserved('')).toBe(true);
    });
  });

  describe('isSinkholedIp', () => {
    test('detects loopback and unspecified sinkhole patterns', () => {
      expect(resolver.isSinkholedIp('127.0.0.1')).toBe(true);
      expect(resolver.isSinkholedIp('127.255.0.1')).toBe(true);
      expect(resolver.isSinkholedIp('0.0.0.0')).toBe(true);
      expect(resolver.isSinkholedIp('::1')).toBe(true);
      expect(resolver.isSinkholedIp('::')).toBe(true);
    });

    test('accepts valid public IPs as not sinkholed', () => {
      expect(resolver.isSinkholedIp('213.21.239.30')).toBe(false);
      expect(resolver.isSinkholedIp('1.1.1.1')).toBe(false);
      expect(resolver.isSinkholedIp('8.8.8.8')).toBe(false);
      expect(resolver.isSinkholedIp('188.114.97.5')).toBe(false);
    });
  });

  describe('Circuit Breaker state transitions', () => {
    test('starts with CLOSED circuit for unknown hosts', () => {
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(false);
    });

    test('trips to OPEN when markPoisoned is called', () => {
      resolver.markPoisoned('dlive.sx', 'ISP sinkhole to 127.0.0.1');
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(true);
    });

    test('never marks local or reserved hosts', () => {
      resolver.markPoisoned('localhost', 'test');
      expect(resolver.isPoisonedHost('localhost')).toBe(false);
      resolver.markPoisoned('127.0.0.1', 'test');
      expect(resolver.isPoisonedHost('127.0.0.1')).toBe(false);
    });

    test('transitions to HALF-OPEN after circuitResetMs expires', async () => {
      resolver.markPoisoned('dlive.sx', 'test');
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(true);

      // Advance past reset timer
      await new Promise(r => setTimeout(r, 1050));
      expect(resolver.isPoisonedHost('dlive.sx')).toBe(false);
    });

    test('evicts oldest entries when maxEntries is reached', () => {
      for (let i = 0; i < 15; i++) {
        resolver.markPoisoned(`host-${i}.com`, 'sinkholed');
      }
      expect(resolver.poisonedHosts.size).toBeLessThanOrEqual(10);
      expect(resolver.isPoisonedHost('host-0.com')).toBe(false); // Evicted
      expect(resolver.isPoisonedHost('host-14.com')).toBe(true); // Retained
    });
  });

  describe('lookup integration', () => {
    let origLookup;

    beforeEach(() => {
      origLookup = dns.lookup;
    });

    afterEach(() => {
      dns.lookup = origLookup;
    });

    test('normal path: passes through directly when system DNS returns clean IP', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, '93.184.216.34', 4);
      });

      resolver.lookup('example.com', (err, addr, family) => {
        expect(err).toBeNull();
        expect(addr).toBe('93.184.216.34');
        expect(family).toBe(4);
        expect(resolver.isPoisonedHost('example.com')).toBe(false);
        done();
      });
    });

    test('fallback path: recovers via secure DNS when system DNS returns 127.0.0.1 sinkhole', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, '127.0.0.1', 4); // Simulated ISP DNS sinkhole
      });

      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['213.21.239.30']);

      resolver.lookup('dlive.sx', (err, addr, family) => {
        expect(err).toBeNull();
        expect(addr).toBe('213.21.239.30');
        expect(family).toBe(4);
        expect(resolver.isPoisonedHost('dlive.sx')).toBe(true); // Circuit breaker tripped
        done();
      });
    });

    test('fast-path: bypasses system DNS when circuit breaker is already OPEN', (done) => {
      resolver.markPoisoned('dlive.sx', 'cached sinkhole');

      dns.lookup = jest.fn(); // Should NOT be called
      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['213.21.239.30']);

      resolver.lookup('dlive.sx', (err, addr, family) => {
        expect(err).toBeNull();
        expect(addr).toBe('213.21.239.30');
        expect(dns.lookup).not.toHaveBeenCalled();
        done();
      });
    });

    test('supports options.all = true correctly with array results', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, [{ address: '127.0.0.1', family: 4 }]);
      });

      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['213.21.239.30', '213.21.239.31']);

      resolver.lookup('dlive.sx', { all: true }, (err, addresses) => {
        expect(err).toBeNull();
        expect(addresses).toEqual([
          { address: '213.21.239.30', family: 4 },
          { address: '213.21.239.31', family: 4 }
        ]);
        done();
      });
    });

    test('recovers when system DNS returns ENOTFOUND', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        const error = new Error('getaddrinfo ENOTFOUND api.watchfooty.st');
        error.code = 'ENOTFOUND';
        cb(error);
      });

      jest.spyOn(resolver, 'resolveSecure').mockResolvedValue(['104.21.45.67']);

      resolver.lookup('api.watchfooty.st', (err, addr) => {
        expect(err).toBeNull();
        expect(addr).toBe('104.21.45.67');
        expect(resolver.isPoisonedHost('api.watchfooty.st')).toBe(true);
        done();
      });
    });

    test('always passes through localhost without interception even on error', (done) => {
      dns.lookup = jest.fn((host, opts, cb) => {
        cb(null, '127.0.0.1', 4);
      });

      const spySecure = jest.spyOn(resolver, 'resolveSecure');

      resolver.lookup('localhost', (err, addr) => {
        expect(err).toBeNull();
        expect(addr).toBe('127.0.0.1');
        expect(spySecure).not.toHaveBeenCalled();
        expect(resolver.isPoisonedHost('localhost')).toBe(false);
        done();
      });
    });
  });
});
