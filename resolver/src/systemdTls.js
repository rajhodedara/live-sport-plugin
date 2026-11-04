import { readFileSync } from 'node:fs'
import path from 'node:path'

// Load systemd-provided credentials only for the explicitly enabled socket
// experiment. The directory and same-user access remain a deployment trust
// boundary; this helper does not authenticate workers or provision keys.
export function systemdTlsOptions(env, activatedFd, read = readFileSync) {
  if (env.RESOLVER_SYSTEMD_TLS !== 'true') return null
  const dir = env.CREDENTIALS_DIRECTORY
  if (activatedFd !== 3 || typeof dir !== 'string' || !path.isAbsolute(dir) || path.normalize(dir) !== dir || dir.includes('\0')) {
    throw new Error('Invalid resolver TLS credentials configuration')
  }
  try {
    const cert = read(path.join(dir, 'resolver.crt'))
    const key = read(path.join(dir, 'resolver.key'))
    if (!Buffer.isBuffer(cert) || !Buffer.isBuffer(key) || !cert.length || !key.length || cert.length > 65536 || key.length > 65536) throw new Error('invalid')
    return { cert, key }
  } catch (_) { throw new Error('Resolver TLS credentials unavailable') }
}
