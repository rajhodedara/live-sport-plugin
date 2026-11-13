'use strict';

const { extractPlayerPhpRefs, LEAD } = require('../src/providers/DaddyLivePlayerRef');

// The expressions this helper replaces, kept verbatim so the differential test can
// prove that ordinary pages resolve to exactly the same reference as before.
const ORIGINAL_CONCRETE = /([^"'\s]*player\.php\?[^"'\s]*[?&]id=\d+[^"'\s]*)/i;
const ORIGINAL_ENDPOINT = /([^"']*player\.php)/i;
const original = (html) => {
  const concrete = html.match(ORIGINAL_CONCRETE);
  const endpoint = html.match(ORIGINAL_ENDPOINT);
  return { concrete: concrete ? concrete[1] : null, endpointRef: endpoint ? endpoint[1] : null };
};

const NORMAL_PAGES = {
  'concrete id in a double-quoted string': '<script>fetch("api/player.php?x=1&id=42")</script>',
  'template only (id appended later)': 'var u = "/api/player.php?id=" + safeId; loadPlayerChannel(91);',
  'single-quoted absolute endpoint': "<script>var e = 'https://vertex.st/p/player.php';</script>",
  'second ? before id': '<a href="/x/player.php?a=b?id=9&t=zzz">play</a>',
  'uppercase': '<a href="/PLAYER.PHP?foo&id=3">x</a>',
  'template followed by the concrete call': 'a("api/player.php?id=" + n); b("api/player.php?k=v&id=77&z=1")',
  'no player.php at all': '<html><body><iframe src="https://example.com/embed/1"></iframe></body></html>',
  'empty page': '',
};

describe('extractPlayerPhpRefs: same answers as the unbounded patterns on ordinary pages', () => {
  for (const [name, html] of Object.entries(NORMAL_PAGES)) {
    test(name, () => {
      expect(JSON.stringify(extractPlayerPhpRefs(html))).toBe(JSON.stringify(original(html)));
    });
  }

  test('non-string input yields nothing instead of throwing', () => {
    expect(JSON.stringify(extractPlayerPhpRefs(undefined))).toBe('{"concrete":null,"endpointRef":null}');
    expect(JSON.stringify(extractPlayerPhpRefs(null))).toBe('{"concrete":null,"endpointRef":null}');
  });
});

describe('extractPlayerPhpRefs: bounded cost on hostile pages', () => {
  const BIG = 150 * 1024;
  const timed = (fn) => { const t = Date.now(); const out = fn(); return { ms: Date.now() - t, out }; };

  test('150 KB quote-free run without player.php is instant', () => {
    const { ms, out } = timed(() => extractPlayerPhpRefs('x'.repeat(BIG)));
    expect(out.endpointRef).toBe(null);
    expect(ms < 200).toBe(true);
  });

  test('player.php AFTER a 150 KB quote-free run (the case includes() alone does not cover)', () => {
    const html = 'x'.repeat(BIG) + '"/api/player.php?k=v&id=5"';
    const { ms, out } = timed(() => extractPlayerPhpRefs(html));
    expect(out.concrete).toBe('/api/player.php?k=v&id=5');
    expect(ms < 1500).toBe(true);
  });

  test('150 KB run with no whitespace or quotes before a non-matching player.php', () => {
    const html = 'y'.repeat(BIG) + ' player.php';
    const { ms } = timed(() => extractPlayerPhpRefs(html));
    expect(ms < 1500).toBe(true);
  });

  test('a reference longer than the lead bound is truncated, never scanned quadratically', () => {
    const html = '"' + 'a'.repeat(LEAD * 4) + 'player.php"';
    const out = extractPlayerPhpRefs(html);
    expect(out.endpointRef.length <= LEAD + 'player.php'.length).toBe(true);
  });
});
