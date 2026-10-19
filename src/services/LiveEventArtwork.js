// Only landscape fixtures use the new artwork. Replay and 24/7 identities stay intact.
function usesLiveEventArtwork(spec = {}) {
  const category = String(spec.category || '').trim().toLowerCase();
  const status = String(spec.status || '').trim().toLowerCase();
  return spec.artwork === 'event-v3' && spec.shape !== 'poster' && ['tennis', 'golf'].includes(category)
    && ['live', 'upcoming'].includes(status);
}

module.exports = { usesLiveEventArtwork };
