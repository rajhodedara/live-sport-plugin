// Node may report null for a server listening on an inherited descriptor.
export function logListeningAddress(server, log = console.log) {
  const addr = server.address()
  if (addr === null || typeof addr === 'string') {
    log('[Resolver] Activated socket is listening')
    return
  }
  const host = `${addr.address.includes(':') ? `[${addr.address}]` : addr.address}:${addr.port}`
  log(`http://${host}/`)
}
