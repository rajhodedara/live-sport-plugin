'use strict';

// Preserve the existing provider classification/defaults while both guarded
// and legacy fetch paths share this policy. Classification is not URL approval.
const isDamitvTarget = url => typeof url === 'string' && url.includes('damitv.st');
const isDembedTarget = url => typeof url === 'string' && url.includes('dembed.st');

function providerRequestHeaders(url, input = {}) {
  if (!isDamitvTarget(url) && !isDembedTarget(url)) return input;
  let headers = Array.isArray(input) && input.length && !Array.isArray(input[0])
    ? Object.fromEntries(Array.from({ length: Math.floor(input.length / 2) }, (_, i) => [input[i * 2], input[i * 2 + 1]]))
    : input && Object.prototype.toString.call(input) === '[object Object]' ? input : Object.fromEntries(new Headers(input || {}));
  const keys = Object.keys(headers);
  if (isDamitvTarget(url)) {
    const uaKey = keys.find(key => key.toLowerCase() === 'user-agent');
    const currentUa = uaKey ? headers[uaKey] : '';
    const validUa = currentUa && !currentUa.includes('Chrome/127');
    const hasRef = keys.some(key => key.toLowerCase() === 'referer');
    headers = { ...headers,
      ...(validUa ? {} : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }),
      ...(hasRef ? {} : { Referer: 'https://damitv.st/' }) };
  } else if (isDembedTarget(url)) {
    headers = {
      ...(keys.some(key => key.toLowerCase() === 'user-agent') ? {} : { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }),
      ...(keys.some(key => key.toLowerCase() === 'referer') ? {} : { Referer: 'https://dlive.sx/' }),
      ...(keys.some(key => key.toLowerCase() === 'sec-fetch-dest') ? {} : {
        'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'cross-site'
      }),
      ...headers
    };
  }
  return headers;
}

module.exports = { providerRequestHeaders, isDamitvTarget, isDembedTarget };
