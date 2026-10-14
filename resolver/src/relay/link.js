export function relayLink(base, target, slot) {
  const q = new URLSearchParams({ url: target })
  if (slot.path) q.set('embed', slot.path)
  if (slot.origin) q.set('embedOrigin', slot.origin)
  if (slot.referer) q.set('referer', slot.referer)
  if (slot.playbackGrant) q.set('pt', slot.playbackGrant)
  return `${base}/api/hls/playlist.m3u8?${q}`
}

export function parseRelaySlot(params) {
  const path = params.get('embed')
  const embedOrigin = params.get('embedOrigin')
  const origin = params.get('origin') // fallback for generic providers
  const referer = params.get('referer')
  const playbackGrant = params.get('pt')
  
  const slot = {}
  
  if (path && embedOrigin) {
    const parts = path.split('/')
    if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('invalid embed path')
    slot.path = path
    slot.origin = embedOrigin
  } else if (origin) {
    slot.origin = origin
  }
  
  if (referer) slot.referer = referer
  if (playbackGrant) slot.playbackGrant = playbackGrant
  return slot
}
