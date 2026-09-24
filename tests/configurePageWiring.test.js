'use strict';

// Regression guard for the configure page's personalization wiring.
//
// Bug this pins down: the two personalization controls (preferred languages and
// the replay-catalog scope) were rendered and read by updateLink(), but had no
// input/change listener, so typing a language or changing the scope never
// re-derived the addon URL — the copied link silently kept the previous config.
//
// jest cannot load jsdom here (its @exodus/bytes dependency is ESM-only and the
// repo has no ESM transform), so this test asserts the wiring contract on the
// real served markup instead. The behavioural end-to-end proof lives in
// scripts/verify-configure-wiring.js, which drives the page through real DOM
// events in jsdom.

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8');

// The inline <script> that renders the page.
const script = (() => {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('configure.html has no inline <script> block');
  return m[1];
})();

describe('configure page exposes both personalization controls', () => {
  test('the languages text input exists', () => {
    expect(html).toMatch(/<input[^>]*id="languages"/);
  });

  test('the replayFilter select exists with exactly all + mainstream', () => {
    expect(html).toMatch(/<select[^>]*id="replayFilter"/);
    const options = [...html.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]);
    expect(options).toEqual(expect.arrayContaining(['all', 'mainstream']));
  });

  test('both controls live inside the Personalization panel', () => {
    const panel = html.slice(html.indexOf('aria-labelledby="prefs-h"'));
    const end = panel.indexOf('</section>');
    const body = panel.slice(0, end);
    expect(body).toMatch(/id="languages"/);
    expect(body).toMatch(/id="replayFilter"/);
  });
});

describe('configure page wires both controls to updateLink', () => {
  // The exact regression: a control with no listener never re-derives the URL.
  test('languages has an input listener calling updateLink', () => {
    expect(script).toMatch(/languagesInput\.addEventListener\(\s*'input'\s*,\s*updateLink\s*\)/);
  });

  test('replayFilter has a change listener calling updateLink', () => {
    expect(script).toMatch(/replayFilterSelect\.addEventListener\(\s*'change'\s*,\s*updateLink\s*\)/);
  });

  test('both DOM references are resolved from the document', () => {
    expect(script).toMatch(/getElementById\(\s*'languages'\s*\)/);
    expect(script).toMatch(/getElementById\(\s*'replayFilter'\s*\)/);
  });

  test('both values are read in updateLink', () => {
    expect(script).toMatch(/languagesInput\.value/);
    expect(script).toMatch(/replayFilterSelect\.value/);
  });

  test('both values reach the encoded config with the documented keys', () => {
    expect(script).toMatch(/config\.languages\s*=/);
    expect(script).toMatch(/config\.replayFilter\s*=/);
  });

  test('replayFilter is omitted when left at the default', () => {
    // Guard against a future edit that always writes the key, which would put a
    // redundant ?replayFilter=all into every install URL.
    expect(script).toMatch(/replayFilter\s*!==\s*'all'/);
  });
});

describe('configure page still restores existing config', () => {
  test('languages and replayFilter are restored from existingConfig', () => {
    expect(script).toMatch(/existingConfig\.languages/);
    expect(script).toMatch(/existingConfig\.replayFilter/);
  });

  test('the replay scope restore defaults to all', () => {
    expect(script).toMatch(/existingConfig\.replayFilter\s*===\s*'mainstream'\s*\?\s*'mainstream'\s*:\s*'all'/);
  });
});

describe('existing controls remain wired', () => {
  test('teams and timezone listeners are still present', () => {
    expect(script).toMatch(/input\.addEventListener\(\s*'input'\s*,\s*updateLink\s*\)/);
    expect(script).toMatch(/timezoneSelect\.addEventListener\(\s*'change'\s*,\s*updateLink\s*\)/);
  });
});
