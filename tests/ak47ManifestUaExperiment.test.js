'use strict';

const Provider = require('../src/providers/Ak47LiveProvider');
const { manifestUserAgent } = require('../src/services/ManifestUserAgent');
const { manifestPlaybackUrl } = require('../src/services/ManifestPlaybackUrl');

test('AK47 sends a source user agent through the manifest URL', async () => {
  const [stream] = await new Provider().resolveStream('https://cdn.example.invalid/live.m3u8', '', 'Fixture', { userAgent: 'FixtureClient/1.0' });
  expect(new URL(stream.url).searchParams.get('hlsua')).toBe('FixtureClient/1.0');
});
test('AK47 leaves the manifest user agent unchanged when no source specifies one', async () => {
  const [stream] = await new Provider().resolveStream('https://cdn.example.invalid/live.m3u8', '', 'Fixture');
  expect(new URL(stream.url).searchParams.has('hlsua')).toBe(false);
});
test('the player-facing manifest alias retains the source user agent', async () => {
  const [stream] = await new Provider().resolveStream('https://cdn.example.invalid/live.m3u8', '', 'Fixture', { userAgent: 'FixtureClient/1.0' });
  const base = new URL(stream.url).origin;
  const published = new URL(manifestPlaybackUrl(stream.url, base));
  expect(published.pathname).toBe('/api/manifest.m3u8');
  expect(published.searchParams.get('hlsua')).toBe('FixtureClient/1.0');
});
test.each(['bad\r\nInjected: yes', 'x'.repeat(513), ['bad'], ''])('rejects invalid user agent input', value => {
  expect(manifestUserAgent(value)).toBe('');
});
