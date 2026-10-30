'use strict';

// Reject control characters and excessive input before using it as an HTTP header.
function manifestUserAgent(value) {
  return typeof value === 'string' && value.length <= 512 && /^[\x20-\x7e]+$/.test(value) ? value : '';
}

module.exports = { manifestUserAgent };
