'use strict';

// PPV.st quality evidence must come from the provider's own source/variant
// metadata or from a verified manifest tier, not the enclosing event title.
// "SD" alone has no exact pixel height, but Raj's requested policy excludes
// provider-labelled SD options as well as explicitly sub-720p variants.
function isLowTierValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  if (!text || text.length > 180) return false;
  const pixels = text.match(/(?:^|[^a-z0-9])([1-9]\d{2,3})\s*p(?:\d{2})?(?=$|[^a-z0-9])/i);
  if (pixels) return Number(pixels[1]) < 720;
  const size = text.match(/(?:^|[^\d])\d{3,4}\s*[x×]\s*(\d{3,4})(?=$|[^\d])/i);
  if (size) return Number(size[1]) < 720;
  const sd = /(?:^|[\s\[\](|:;\-–—])SD(?=$|[\s\[\])|:;\-–—])/i.test(text);
  // A combined "HD / SD" listing is ambiguous, not a reason to discard an
  // otherwise useful higher-tier alternative.
  const hd = /(?:^|[\s\[\](|:;\-–—])(?:HD|FHD|UHD|4K|720p|1080p|2160p)(?=$|[\s\[\])|:;\-–—])/i.test(text);
  return sd && !hd;
}

function isLowPpvSourceMetadata(source, { includeName = false } = {}) {
  if (!source || typeof source !== 'object') return false;
  const fields = [source.resolution, source.quality, source.source_tag, source.channelName];
  if (includeName) fields.push(source.name);
  return fields.some(isLowTierValue);
}

module.exports = { isLowTierValue, isLowPpvSourceMetadata };
