'use strict';
jest.mock('../src/impitClient', () => ({ safeFetch: jest.fn() }));
const Nfl = require('../src/providers/NflVideoProvider');
const Mlb = require('../src/providers/MlbLiveProvider');
const Basketball = require('../src/providers/BasketballVideoProvider');

test.each([['NFL', Nfl, '_isVidaraUrl', 'vidara.so'], ['MLB', Mlb, '_isVidaraUrl', 'vidara.so'],
  ['NFL', Nfl, '_isDailymotionUrl', 'dailymotion.com'], ['MLB', Mlb, '_isDailymotionUrl', 'dailymotion.com'],
  ['NFL', Nfl, '_isDTubeUrl', 'd.tube']])('%s recognizes the actual host for %s', (_name, Provider, method, domain) => {
  const provider = new Provider();
  expect(provider[method](`https://${domain}/watch`)).toBe(true);
  expect(provider[method](`//player.${domain}/watch`)).toBe(true);
  expect(provider[method](`https://${domain}.other.example/watch`)).toBe(false);
  expect(provider[method](`https://other.example/path/${domain}`)).toBe(false);
});

test.each([['NFL', Nfl], ['MLB', Mlb], ['Basketball', Basketball]])('%s Byse detection checks the actual host', (_name, Provider) => {
  const provider = new Provider();
  expect(provider._isByseUrl('https://bysefujedu.com/e/abc')).toBe(true);
  expect(provider._isByseUrl('//cdn.bysefujedu.com/e/abc')).toBe(true);
  expect(provider._isByseUrl('https://bysefujedu.com.other.example/e/abc')).toBe(false);
  expect(provider._isByseUrl('https://other.example/bysefujedu.com')).toBe(false);
});
