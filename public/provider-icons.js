/* Provider icons shared by the setup and status pages.
   window.ProviderIcon(idOrName, label) returns an HTML string for a small tile:
   a sport glyph when the provider name implies a sport, otherwise a two-letter monogram.
   Nothing is fetched from provider sites. */
(function () {
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var ICONS = {
    football: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8.5l3.2 2.3-1.2 3.7h-4l-1.2-3.7z"/><path d="M12 8.5V3.2M15.2 10.8l5-1.6M14 14.5l3 4.2M10 14.5l-3 4.2M8.8 10.8l-5-1.6"/>'),
    basketball: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6c3.6 3.6 3.6 9.2 0 12.8M18.4 5.6c-3.6 3.6-3.6 9.2 0 12.8"/>'),
    afootball: svg('<path d="M4 20C4 11 11 4 20 4c0 9-7 16-16 16z"/><path d="M9 15l6-6M10.5 10.5l3 3"/>'),
    hockey: svg('<path d="M5 3l8 14h6"/><ellipse cx="9" cy="20" rx="4" ry="1.5"/>'),
    baseball: svg('<circle cx="12" cy="12" r="9"/><path d="M7 4.5c2 2.2 2 12.8 0 15M17 4.5c-2 2.2-2 12.8 0 15"/>'),
    motorsport: svg('<path d="M5 21V4"/><path d="M5 4h13l-2 4 2 4H5"/><path d="M9 4v8M13 4v8"/>'),
    replay: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>'),
    tv: svg('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>')
  };
  var RULES = [
    [/basketball/, 'basketball'],
    [/nfl|americanfootball/, 'afootball'],
    [/hockey|nhl/, 'hockey'],
    [/mlb|baseball/, 'baseball'],
    [/race|motor|f1|formula/, 'motorsport'],
    [/soccer|footy|football/, 'football'],
    [/replay/, 'replay'],
    [/livetv|cdnlive/, 'tv']
  ];
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function monogram(name) {
    var words = String(name || '').replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return '?';
    var m = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
    return m.toUpperCase();
  }
  window.ProviderIcon = function (idOrName, label) {
    var key = String(idOrName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    var glyph = null;
    for (var i = 0; i < RULES.length; i++) {
      if (RULES[i][0].test(key)) { glyph = ICONS[RULES[i][1]]; break; }
    }
    var inner = glyph ? glyph : '<span class="mono">' + esc(monogram(label || idOrName)) + '</span>';
    return '<span class="prov-icon" aria-hidden="true">' + inner + '</span>';
  };
})();
