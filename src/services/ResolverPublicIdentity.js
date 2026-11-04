'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');

// Experimental credential reader: this does not establish that the directory
// was provisioned by systemd or is protected from other same-user processes.
// Each worker must get its expected certificate via a trusted deployment path.
function readResolverPublicIdentity(directory, expectedHost, read = fs.readFileSync) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory ||
      directory.includes('\0') || typeof expectedHost !== 'string' || !/^[a-z0-9.-]{1,253}$/i.test(expectedHost)) {
    throw new TypeError('Invalid resolver public identity configuration');
  }
  try {
    const bytes = read(path.join(directory, 'resolver.crt'));
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) throw new Error('invalid certificate');
    const certificatePem = bytes.toString('utf8');
    new X509Certificate(certificatePem);
    return Object.freeze({ certificatePem, expectedHost });
  } catch (_) { throw new Error('Resolver public certificate unavailable'); }
}

module.exports = { readResolverPublicIdentity };
