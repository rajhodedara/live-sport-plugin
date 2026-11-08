/* Adds a "Sign out" icon button to the top bar when the visitor is signed in.
   Does nothing when accounts are disabled or nobody is signed in. */
(function () {
  var bar = document.querySelector('.topbar');
  if (!bar || document.getElementById('signOutBtn')) return;
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (!me || !me.authenticated) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'signOutBtn';
      b.className = 'icon-btn';
      b.setAttribute('aria-label', 'Sign out');
      b.title = 'Sign out';
      b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>';
      b.addEventListener('click', function () {
        b.disabled = true;
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function () { location.href = '/account'; }, function () { b.disabled = false; });
      });
      bar.appendChild(b);
    })
    .catch(function () {});
})();
