// Experimental opt-in socket activation. A valid descriptor is not proof of
// identity for clients and does not itself secure a socket path.
export function systemdSocketFd(env, pid) {
  if (env.RESOLVER_SYSTEMD_SOCKET !== 'true') return null
  if (!Number.isSafeInteger(pid) || pid < 1 || env.LISTEN_PID !== String(pid) || env.LISTEN_FDS !== '1') {
    throw new Error('Invalid resolver socket activation environment')
  }
  return 3
}
