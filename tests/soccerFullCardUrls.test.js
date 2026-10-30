'use strict';
const SoccerFullProvider = require('../src/providers/SoccerFullProvider');

describe('SoccerFull card URLs', () => {
  test.each([
    ['/first-4468.html', '/first-4468.html'],
    ['https://soccerfull.net/first-4468.html', '/first-4468.html'],
    ['https://soccerfull.net/first-4468.html?quality=hd', '/first-4468.html?quality=hd'],
  ])('keeps the correct path for %s', (href, path) => {
    const html = `<li class="item-movie"><a href="${href}" title="First match"></a></li>`;
    const matches = new SoccerFullProvider()._parseMatchCards(html);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe('sf_4468');
    expect(matches[0].sources[0]).toMatchObject({ id: path, url: `https://soccerfull.net${path}` });
  });
  test('ignores a link to an unrelated host', () => {
    const html = '<li class="item-movie"><a href="https://other.example/first-4468.html" title="First match"></a></li>';
    expect(new SoccerFullProvider()._parseMatchCards(html)).toEqual([]);
  });
});
