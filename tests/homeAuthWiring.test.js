'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('authenticated home dashboard', () => {
  test('checks the browser session before loading protected events', () => {
    expect(html).toContain("fetch('/api/auth/status'");
    expect(html).toContain("fetch('/api/auth/me'");
    expect(html).toContain('Sign in to view live matches');
  });

  test('uses session-authenticated catalog and stream endpoints', () => {
    expect(html).toContain('/api/auth/web/catalog/');
    expect(html).toContain('/api/auth/web/stream/');
    expect(html).toContain("credentials: 'same-origin'");
  });

  test('does not interpret authentication errors as empty catalogs', () => {
    expect(html).toContain('if (!res.ok) throw new Error(`Catalog request failed (${res.status})`)');
    expect(html).toContain('if (!res.ok) throw new Error(`Stream request failed (${res.status})`)');
  });
});
