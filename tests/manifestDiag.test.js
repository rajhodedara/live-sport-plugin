'use strict';

jest.mock('../src/container', () => ({
  resolve: () => { throw new Error('container unavailable'); }
}));

const { hostOf, sourceOfRck, describeManifestError } = require('../src/services/ManifestDiag');
const { attemptRemint } = require('../src/remint');

describe('ManifestDiag helpers', () => {
  test('hostOf returns the upstream host and never throws', () => {
    expect(hostOf('https://netanyahu.indianservers.st/a/b.m3u8?token=x')).toBe('netanyahu.indianservers.st');
    expect(hostOf('http://10.0.0.1:8008/x')).toBe('10.0.0.1:8008');
    expect(hostOf('not a url')).toBe('unknown');
    expect(hostOf(undefined)).toBe('unknown');
  });

  test('sourceOfRck keeps only a short, safe source name', () => {
    expect(sourceOfRck('PpvSt:match:1')).toBe('ppvst');
    expect(sourceOfRck('daddylive:1:2')).toBe('daddylive');
    expect(sourceOfRck('')).toBe('none');
    expect(sourceOfRck(null)).toBe('none');
    expect(sourceOfRck('bad source\nINJECT:1:2')).toBe('none');
    expect(sourceOfRck('x'.repeat(40) + ':1:2')).toBe('none');
  });

  test('describeManifestError combines both without echoing paths or queries', () => {
    const line = describeManifestError('https://hls.lshls.st/live/x.m3u8?token=SECRET', 'embedindia:m:s');
    expect(line).toBe('source=embedindia host=hls.lshls.st');
    expect(line.includes('SECRET')).toBe(false);
  });
});

describe('attemptRemint failure logging', () => {
  test('a failed re-mint reports the source and elapsed ms and still returns null', async () => {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => { lines.push(args.join(' ')); };
    let result;
    try {
      result = await attemptRemint('ppvst:match1:src1', 'https://x.invalid/a.m3u8');
    } finally {
      console.warn = original;
    }
    expect(result).toBe(null);
    const line = lines.find(l => l.includes('re-mint failed:'));
    expect(Boolean(line)).toBe(true);
    expect(/source=ppvst ms=\d+$/.test(line)).toBe(true);
  });
});
