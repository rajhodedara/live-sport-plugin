'use strict';

// Classification selects an existing egress/profile; the transport must still
// validate every URL, resolved address and redirect before allocating a slot.
function hostnameOf(value, rejectUserinfo = false) {
  try {
    if (typeof value !== 'string' && !(value instanceof URL)) return '';
    if (rejectUserinfo && /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(String(value))) return '';
    const parsed = new URL(String(value));
    if (rejectUserinfo && (parsed.username || parsed.password)) return '';
    return parsed.hostname.toLowerCase().replace(/\.$/, '');
  } catch (_) { return ''; }
}

function isDamitvTarget(value) {
  const host = hostnameOf(value);
  return host === 'damitv.st' || host.endsWith('.damitv.st');
}

function isDamitvMediaTarget(value) {
  if (!isDamitvTarget(value)) return false;
  try { return new URL(String(value)).pathname.startsWith('/c/'); }
  catch (_) { return false; }
}

function isSportsbiteTarget(value) {
  const host = hostnameOf(value);
  return host === 'sportsbite.org' || host.endsWith('.sportsbite.org');
}

function selectGuardedEgress(url, options = {}, environment = process.env) {
  const dami = isDamitvTarget(url);
  const sportsbite = isSportsbiteTarget(url);
  // An explicit null is the caller's direct-egress choice, not a missing value.
  // Resolve this once per request and retain it throughout its redirect chain.
  const configuredProxy = dami
    ? environment.WARP_PROXY_URL || environment.DAMITV_PROXY_URL
    : (sportsbite ? environment.WARP_PROXY_URL : null);
  const proxyUrl = Object.hasOwn(options, 'proxyUrl') ? options.proxyUrl || null : configuredProxy || null;
  const profile = options.profile || (proxyUrl || dami ? 'vanilla' : 'chrome');
  return { proxyUrl, profile };
}

module.exports = { isDamitvTarget, isDamitvMediaTarget, isSportsbiteTarget, selectGuardedEgress };
