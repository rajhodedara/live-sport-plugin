/* Hamburger toggle for the left navigation.
   Wide screens: collapses / expands the sidebar column and remembers the choice.
   Narrow screens (pages with data-drawer="true" on the button): opens the sidebar as a drawer. */
(function () {
  var toggle = document.getElementById('navToggle');
  var sidebar = document.querySelector('.sidebar');
  if (!toggle || !sidebar) return;
  var root = document.documentElement;
  var scrim = document.getElementById('drawerScrim');
  var wide = window.matchMedia('(min-width: 1180px)');
  var hasDrawer = toggle.getAttribute('data-drawer') === 'true';

  function isOpen() {
    if (wide.matches) return root.getAttribute('data-sidebar') !== 'collapsed';
    return root.getAttribute('data-drawer') === 'open';
  }
  function paint() {
    var open = isOpen();
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  }
  function closeDrawer() { root.removeAttribute('data-drawer'); paint(); }

  toggle.addEventListener('click', function () {
    if (wide.matches) {
      var collapsed = root.getAttribute('data-sidebar') === 'collapsed';
      if (collapsed) root.removeAttribute('data-sidebar'); else root.setAttribute('data-sidebar', 'collapsed');
      try { localStorage.setItem('nuvio-sidebar', collapsed ? 'open' : 'collapsed'); } catch (e) {}
    } else if (hasDrawer) {
      if (root.getAttribute('data-drawer') === 'open') root.removeAttribute('data-drawer'); else root.setAttribute('data-drawer', 'open');
    }
    paint();
  });
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && root.getAttribute('data-drawer') === 'open') { closeDrawer(); toggle.focus(); }
  });
  sidebar.addEventListener('click', function (e) {
    if (!wide.matches && e.target.closest('.cat-item')) closeDrawer();
  });
  var onChange = function () { root.removeAttribute('data-drawer'); paint(); };
  if (wide.addEventListener) wide.addEventListener('change', onChange);
  paint();
})();
