'use strict';

const IframeDomainRegistry = require('../src/services/IframeDomainRegistry');

describe('IframeDomainRegistry — slug collapsing', () => {
  const cases = [
    ['assetrage.net', 'assetrage.net'],
    ['b9x39g.a737cozfwjmm.net', 'a737cozfwjmm.net'],
    ['c2807p.7odxv0l067ka.net', '7odxv0l067ka.net'],
    ['1698b63550d1707926c0bf588d868eb7.dynproclaim.net', 'dynproclaim.net'],
    ['w1.sportsonlinee.click', 'sportsonlinee.click'],
    ['hls.hockey.do', 'hockey.do'],
    ['dlstreams.st', 'dlstreams.st'],
    ['edgestream2.pro', 'edgestream.pro'],
    ['edgestream7.pro', 'edgestream.pro'],
    ['edgestream10.pro', 'edgestream.pro'],
    ['edgestream.pro', 'edgestream.pro'],
    ['x.y.co.uk', 'y.co.uk'],
  ];
  test.each(cases)('%s -> %s', (input, expected) => {
    expect(IframeDomainRegistry.toSlug(input)).toBe(expected);
  });

  test('rotating node prefixes collapse onto one family', () => {
    const a = IframeDomainRegistry.toSlug('edgestream5.pro');
    const b = IframeDomainRegistry.toSlug('edgestream7.pro');
    const c = IframeDomainRegistry.toSlug('edgestream2.pro');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('normalizeHost strips port and case', () => {
    expect(IframeDomainRegistry.normalizeHost('C2807P.7odxv0l067ka.net:8443')).toBe('c2807p.7odxv0l067ka.net');
  });
});

describe('IframeDomainRegistry — knowledge lookup', () => {
  const reg = new IframeDomainRegistry();

  test('loads the shipped knowledge base', () => {
    expect(reg.isLoaded).toBe(true);
    expect(reg.has('assetrage.net')).toBe(true);
  });

  test('recognises known families behind rotating prefixes', () => {
    // a737cozfwjmm.net is a terminal host family, and dynproclaim is an embed family
    expect(reg.has('1698b63550d1707926c0bf588d868eb7.dynproclaim.net')).toBe(true);
    expect(reg.get('assetrage.net').strategy).toBe('econfig');
  });

  test('dynproclaim uses the same econfig strategy as assetrage', () => {
    // This is the user's observation, pinned as a regression.
    const assetrage = reg.get('assetrage.net');
    const dynproclaim = reg.get('sub.dynproclaim.net');
    expect(assetrage.strategy).toBe('econfig');
    expect(dynproclaim).not.toBeNull();
    expect(dynproclaim.strategy).toBe('econfig');
  });

  test('reports unknown domains as unknown', () => {
    expect(reg.has('some.brand.new.host')).toBe(false);
    expect(reg.strategyFor('some.brand.new.host')).toBeNull();
  });

  test('terminal referer is resolved for known hosts', () => {
    expect(reg.refererFor('c2807p.7odxv0l067ka.net')).toBe('https://assetrage.net/');
    expect(reg.refererFor('edgestream7.pro')).toBe('https://streame.center/');
    expect(reg.refererFor('unknown.host.example')).toBe('https://unknown.host.example/');
  });

  test('platform noise is ignored', () => {
    expect(reg.isIgnored('vk.com')).toBe(true);
    expect(reg.isIgnored('www.google-analytics.com')).toBe(true);
    expect(reg.isIgnored('assetrage.net')).toBe(false);
  });
});

describe('IframeDomainRegistry — runtime learning (self-healing)', () => {
  test('learns a previously-unknown host strategy', () => {
    const reg = new IframeDomainRegistry();
    const host = 'brand-new-embed.example';
    expect(reg.has(host)).toBe(false);

    const learned = reg.learn(host, 'econfig', { role: 'embed' });
    expect(learned).toBe(true);
    expect(reg.has(host)).toBe(true);
    expect(reg.strategyFor(host)).toBe('econfig');
  });

  test('learned strategy is keyed by family, so a sibling node inherits it', () => {
    const reg = new IframeDomainRegistry();
    reg.learn('node42.newfamily.example', 'direct', { role: 'embed' });
    expect(reg.strategyFor('node99.newfamily.example')).toBe('direct');
  });

  test('does not overwrite a file-seeded strategy with one observation', () => {
    const reg = new IframeDomainRegistry();
    const before = reg.get('assetrage.net').strategy;
    const learned = reg.learn('assetrage.net', 'something-else', { role: 'embed' });
    expect(learned).toBe(false);
    expect(reg.get('assetrage.net').strategy).toBe(before);
  });

  test('refuses to learn platform noise', () => {
    const reg = new IframeDomainRegistry();
    expect(reg.learn('vk.com', 'econfig')).toBe(false);
    expect(reg.has('vk.com')).toBe(false);
  });

  test('never throws on bad input', () => {
    const reg = new IframeDomainRegistry();
    expect(() => reg.learn(null, 'econfig')).not.toThrow();
    expect(() => reg.learn('x.example', null)).not.toThrow();
    expect(() => reg.get(undefined)).not.toThrow();
    expect(() => reg.get(null)).not.toThrow();
  });
});

describe('IframeDomainRegistry — candidate ranking', () => {
  const reg = new IframeDomainRegistry();

  test('ranks known embed hosts above wrappers and drops noise', () => {
    const ranked = reg.rankCandidates([
      'vk.com',                 // noise -> dropped
      'brandnew.example',       // unknown -> kept, lowest
      'streame.center',         // known wrapper
      'assetrage.net',          // known embed + known decoder -> highest
    ]);
    expect(ranked).not.toContain('vk.com');
    expect(ranked[0]).toBe('assetrage.net');
    expect(ranked).toContain('streame.center');
    expect(ranked).toContain('brandnew.example');
  });

  test('returns an empty list when every candidate is noise', () => {
    expect(reg.rankCandidates(['vk.com', 'google-analytics.com'])).toEqual([]);
  });

  test('handles empty / malformed input', () => {
    expect(reg.rankCandidates([])).toEqual([]);
    expect(() => reg.rankCandidates(null)).not.toThrow();
  });
});

describe('IframeDomainRegistry — snapshot', () => {
  test('toJSON exposes the loaded knowledge base', () => {
    const reg = new IframeDomainRegistry();
    const snap = reg.toJSON();
    expect(snap.loaded).toBe(true);
    expect(snap.families['assetrage.net'].strategy).toBe('econfig');
    expect(snap.terminal_hosts['7odxv0l067ka.net'].referer).toBe('https://assetrage.net/');
  });
});
