'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'account.html'), 'utf8');

describe('account page wiring', () => {
  test('provides a way back to the home dashboard', () => {
    expect(html).toMatch(/<a class="link-btn home-link" href="\/">← Home<\/a>/);
  });

  test('provides accessible registration and login controls', () => {
    expect(html).toMatch(/<form id="authForm">/);
    expect(html).toMatch(/type="email"[^>]*autocomplete="email"/);
    expect(html).toMatch(/type="password"[^>]*autocomplete="current-password"/);
    expect(html).toContain("setMode('register')");
    expect(html).toContain("api('/' + mode");
  });

  test('supports device creation, one-time display, revocation, and deletion', () => {
    expect(html).toContain('id="deviceForm"');
    expect(html).toContain("api('/devices'");
    expect(html).toContain("sessionStorage.setItem('nuvioDeviceToken'");
    expect(html).toContain("method: 'DELETE'");
    expect(html).toContain("'/permanent'");
    expect(html).toContain("remove.textContent = 'Delete'");
    expect(html).toContain('id="deviceToken"');
  });

  test('does not place a password into an install URL', () => {
    expect(html).not.toMatch(/manifestUrl[^;]*password/);
    expect(html).not.toMatch(/accessToken\s*=\s*password/);
  });
});
