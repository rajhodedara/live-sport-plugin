'use strict';
jest.mock('../src/impitClient', () => ({ getImpit: jest.fn() }));
const FullRacesProvider = require('../src/providers/FullRacesProvider');

describe('FullRaces listing card isolation', () => {
  const broken = '<div class="short_item block_elem"><div class="poster"><a href="/broken"><img src="/broken.png"></a></div></div>';
  const valid = '<div class="short_item block_elem"><div class="poster"><a href="/valid"><img src="/valid.png"></a></div><h3><a>IndyCar Replay</a></h3><div class="short_cat"><a>IndyCar</a></div><div class="short_descr"><p>Race</p></div></div>';
  test('does not pair a broken card URL with the following valid card', () => {
    const matches = new FullRacesProvider()._parseListingHtml(broken + valid);
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe('IndyCar Replay');
    expect(matches[0].sources[0].url).toBe('https://fullraces.com/valid');
  });
  test('retains valid cards following other valid cards', () => {
    const second = valid.replaceAll('/valid', '/second').replace('IndyCar Replay', 'Second Replay');
    const matches = new FullRacesProvider()._parseListingHtml(valid + second);
    expect(matches.map(m => m.sources[0].url)).toEqual(['https://fullraces.com/valid', 'https://fullraces.com/second']);
  });
});
