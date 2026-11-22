const RoxieStreamsProvider = require('../src/providers/RoxieStreamsProvider');

describe('RoxieStreamsProvider', () => {
  const mockCircuitBreaker = {
    wrap: (name, fn) => ({ fire: fn })
  };

  test('has correct provider metadata and defaults', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    expect(provider.name).toBe('RoxieStreams');
    expect(provider.sourceName).toBe('roxiestreams');
    expect(provider.baseUrl).toBe('https://roxiestreams.su');
  });

  test('correctly maps sport categories to canonical categories', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    expect(provider._mapCategory('soccer')).toBe('football');
    expect(provider._mapCategory('nba')).toBe('basketball');
    expect(provider._mapCategory('nfl')).toBe('american_football');
    expect(provider._mapCategory('nhl')).toBe('hockey');
    expect(provider._mapCategory('mlb')).toBe('baseball');
    expect(provider._mapCategory('fighting')).toBe('mma');
    expect(provider._mapCategory('motorsports')).toBe('motorsport');
    expect(provider._mapCategory('f1')).toBe('motorsport');
    expect(provider._mapCategory('unknown_sport')).toBe('other');
  });

  test('parses table listings into valid MatchEntity records', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const htmlFixture = `
      <table>
        <tr>
          <th>Event</th>
          <th>Start Time</th>
          <th>Countdown</th>
        </tr>
        <tr>
          <td>
            <a href="/soccer-streams-1">
              Juventus vs Venezia
            </a>
          </td>
          <td class="event-start-time">
            November 22, 2026 3:30 AM
          </td>
          <td>
            <span class="countdown-timer"></span>
          </td>
        </tr>
        <tr>
          <td>
            <a href="/soccer-streams-2">
              Burnley vs Blackburn Rovers
            </a>
          </td>
          <td class="event-start-time">
            November 22, 2026 4:00 AM
          </td>
          <td>
            <span class="countdown-timer"></span>
          </td>
        </tr>
      </table>
    `;

    const matches = provider._parseListingHtml(htmlFixture, 'soccer');
    expect(matches).toHaveLength(2);

    expect(matches[0].title).toBe('Juventus vs Venezia');
    expect(matches[0].category).toBe('football');
    expect(matches[0].id).toMatch(/^roxiestreams_soccer-streams-1_/);
    expect(matches[0].sources).toHaveLength(1);
    expect(matches[0].sources[0]).toEqual({
      source: 'roxiestreams',
      id: '/soccer-streams-1',
      name: 'RoxieStreams',
      path: '/soccer-streams-1'
    });
    expect(matches[0].date).toBeTruthy();

    expect(matches[1].title).toBe('Burnley vs Blackburn Rovers');
    expect(matches[1].sources[0].id).toBe('/soccer-streams-2');
  });

  test('generates distinct match IDs when the same channel slug is reused for different kickoffs', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const htmlFixture = `
      <table>
        <tr>
          <td><a href="/soccer-streams-1">Juventus vs Venezia</a></td>
          <td class="event-start-time">November 22, 2026 3:30 AM</td>
        </tr>
        <tr>
          <td><a href="/soccer-streams-1">Bologna vs Udinese</a></td>
          <td class="event-start-time">November 22, 2026 6:00 AM</td>
        </tr>
      </table>
    `;

    const matches = provider._parseListingHtml(htmlFixture, 'soccer');
    expect(matches).toHaveLength(2);
    expect(matches[0].id).not.toBe(matches[1].id);
    expect(matches[0].sources[0].id).toBe('/soccer-streams-1');
    expect(matches[1].sources[0].id).toBe('/soccer-streams-1');
  });

  test('parses stream page buttons into StreamEntity records with manifest proxy URLs', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const streamPageFixture = `
      <!DOCTYPE html>
      <html>
      <head>
        <script>
          var subdomain = 'admin2';
          var domains = ['formaturamaxi.com.br'];
        </script>
      </head>
      <body>
        <div id="playerContainer"></div>
        <button class="streambutton" onclick="showPlayer('clappr', getRandomStream('tnt.m3u8', 'admin2'))">Stream 1</button>
        <button class="streambutton" onclick="showPlayer('clappr', getRandomStream('ncaa16.m3u8', 'admin2'))">Stream 2</button>
      </body>
      </html>
    `;

    const streams = provider._parseStreamPageHtml(streamPageFixture, 'formaturamaxi.com.br');
    expect(streams).toHaveLength(2);

    expect(streams[0].name).toBe('RoxieStreams');
    expect(streams[0].title).toBe('Stream 1 (HD)');
    expect(streams[0].url).toContain('/api/manifest?url=');
    expect(streams[0].url).toContain(encodeURIComponent('https://admin2.formaturamaxi.com.br/tnt.m3u8'));
    expect(streams[0].url).toContain(`referer=${encodeURIComponent('https://roxiestreams.su/')}`);
    expect(streams[0].url).toContain(`origin=${encodeURIComponent('https://roxiestreams.su')}`);
    expect(streams[0].resolution).toBe('HD');
    expect(streams[0].behaviorHints.notWebReady).toBe(false);
    expect(streams[0].behaviorHints.proxyHeaders.request).toEqual({
      Origin: 'https://roxiestreams.su',
      Referer: 'https://roxiestreams.su/',
      'User-Agent': expect.any(String),
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Accept': '*/*'
    });
    expect(streams[0]._source).toBe('roxiestreams');

    expect(streams[1].url).toContain(encodeURIComponent('https://admin2.formaturamaxi.com.br/ncaa16.m3u8'));
    expect(streams[1].title).toBe('Stream 2 (HD)');
  });

  test('parses direct full m3u8 URLs in showPlayer', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const streamPageFixture = `
      <div id="playerContainer"></div>
      <button class="streambutton" onclick="showPlayer('clappr', 'https://bein-esp-xumo.amagi.tv/playlist.m3u8')">Direct Stream</button>
    `;

    const streams = provider._parseStreamPageHtml(streamPageFixture, 'formaturamaxi.com.br');
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toContain(encodeURIComponent('https://bein-esp-xumo.amagi.tv/playlist.m3u8'));
    expect(streams[0].behaviorHints.proxyHeaders.request).toEqual({
      Origin: 'https://roxiestreams.su',
      Referer: 'https://roxiestreams.su/',
      'User-Agent': expect.any(String),
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Accept': '*/*'
    });
  });

  test('falls back to default fallback domain if no domain provided', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    const streamPageFixture = `
      <script>var subdomain = 'admin2';</script>
      <button class="streambutton" onclick="showPlayer('clappr', getRandomStream('tnt.m3u8', 'admin2'))">Stream 1</button>
    `;

    const streams = provider._parseStreamPageHtml(streamPageFixture, null);
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toContain(encodeURIComponent('https://admin2.shadow-ran.online/tnt.m3u8'));
  });

  test('returns empty array when HTML contains no events or streams', () => {
    const provider = new RoxieStreamsProvider({ circuitBreaker: mockCircuitBreaker });
    expect(provider._parseListingHtml('<html><body>No events</body></html>', 'nba')).toEqual([]);
    expect(provider._parseStreamPageHtml('<html><body>No streams</body></html>', 'formaturamaxi.com.br')).toEqual([]);
  });
});
