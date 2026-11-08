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

function isLeafTarget(value) {
  const host = hostnameOf(value, true);
  const isHighfly = host === 'highfly.to' || host.endsWith('.highfly.to') ||
                    host === 'highfly.dev' || host.endsWith('.highfly.dev');
  return isHighfly ||
    ((host === 'papacito.cfd' || host.endsWith('.papacito.cfd')) &&
      host !== 'w1.papacito.cfd' && !host.endsWith('.w1.papacito.cfd') &&
      host !== 'east.papacito.cfd' && !host.endsWith('.east.papacito.cfd'));
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

function selectGuardedEgress(url, options = {}, environment = process.env) {
  const leaf = isLeafTarget(url);
  const dami = isDamitvTarget(url);
  // An explicit null is the caller's direct-egress choice, not a missing value.
  // Resolve this once per request and retain it throughout its redirect chain.
  const configuredProxy = leaf
    ? environment.LEAF_PROXY_URL || environment.WARP_PROXY_URL || environment.DAMITV_PROXY_URL
    : dami ? environment.WARP_PROXY_URL || environment.DAMITV_PROXY_URL : null;
  const proxyUrl = Object.hasOwn(options, 'proxyUrl') ? options.proxyUrl || null : configuredProxy || null;
  // Leaf's new stable proxy uses Chrome142; the guarded 'chrome' slot already
  // provides that profile. DamiTV and other explicit proxies retain vanilla.
  const profile = options.profile || (leaf ? 'chrome' : proxyUrl || dami ? 'vanilla' : 'chrome');
  return { proxyUrl, profile };
}

function validateLeafManifestUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 16 * 1024 ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) throw new Error();
    // Accept papacito.cfd delivery hosts (authenticated segments with ?token= or ?ft=
    // JWT credentials) and recaps.highfly.to / *.highfly.to delivery hosts (unauthenticated
    // backup streams introduced in 2026-11). Both are served via the Leaf egress profile.
    const h = parsed.hostname;
    const isPapacito = h === 'papacito.cfd' || h.endsWith('.papacito.cfd');
    const isHighflyDelivery = h === 'recaps.highfly.to' || h.endsWith('.recaps.highfly.to') ||
                               h === 'highfly.to' || h.endsWith('.highfly.to') ||
                               h === 'highfly.dev' || h.endsWith('.highfly.dev');
    if (!isPapacito && !isHighflyDelivery) throw new Error();
  } catch (_) {
    throw Object.assign(new Error('Invalid Leaf manifest URL'), { code: 'ERR_LEAF_MANIFEST_URL', statusCode: 400 });
  }
  // The provider and route share admission; never serialize a signed query.
  return value;
}

module.exports = { isLeafTarget, isDamitvTarget, isDamitvMediaTarget, selectGuardedEgress, validateLeafManifestUrl };
