class StreamScoringService {
  constructor() {}

  /**
   * Calculates a score out of 100 for a stream to determine sorting order.
   * Higher score = better UX for the user.
   */
  calculateScore(streamEntity, sourceName) {
    let score = 50; // Base score

    // 1. Native HLS vs Web Player (External)
    if (streamEntity.url) {
      score += 30; // Direct streaming is always preferred
    } else if (streamEntity.externalUrl) {
      score -= 20; // Having to open a web browser is a worse UX
    }

    // 2. Resolution
    const title = streamEntity.title || streamEntity.name || '';
    const res = String(streamEntity.resolution || streamEntity.quality || '').toLowerCase();
    if (title.includes('1080p') || res.includes('1080')) {
      score += 20;
    } else if (title.includes('720p') || res.includes('720')) {
      score += 10;
    } else if (title.includes('540p') || title.includes('SD') || res.includes('540') || res === 'sd') {
      score -= 5;
    }

    // 3. TikTok CDN / Cloudflare Worker Penalty
    // Streams that offload video chunks onto TikTok CDN require Cloudflare Worker
    // proxying to uncloak the 42-byte fake WebP RIFF header. To save limited CF
    // worker invocations, heavily prioritize clean direct CDN streams.
    const isTikTok = Boolean(
      streamEntity.isTikTok ||
      streamEntity._isTikTok ||
      (typeof streamEntity.url === 'string' && /tiktokcdn|byteoversea|ibytedtos|\.image/i.test(streamEntity.url))
    );

    const src = sourceName || streamEntity._source;
    // Zero-bandwidth ByteRange providers (pitsport, timstreams) use #EXT-X-BYTERANGE
    // direct redirects and do not consume Cloudflare Worker proxying.
    const isZeroBandwidthByteRange = (src === 'pitsport' || src === 'timstreams');

    if (isTikTok && !isZeroBandwidthByteRange) {
      score -= 30; // Deprioritize worker-heavy streams
    } else {
      // Direct CDN bonus for providers that bypass Cloudflare Workers entirely:
      // leaf (+30), timstreams (+25), ppvst (+20), pitsport (+15), daddylive (+10), vavoo (+5), sktech (+5)
      if (src === 'leaf') {
        score += 30;
      } else if (src === 'timstreams') {
        score += 25;
      } else if (src === 'ppvst') {
        score += 20;
      } else if (src === 'pitsport') {
        score += 15;
      } else if (src === 'daddylive') {
        score += 10;
      } else if (src === 'vavoo') {
        score += 5;
      } else if (src === 'sktech') {
        score += 5;
      } else {
        const otherDirect = ['golf', 'damitv'];
        if (otherDirect.includes(src)) {
          score += 5;
        }
      }
    }

    // 4. Source Reliability
    // Non-TikTok (or zero-bandwidth ByteRange) reliable sources
    const reliableSources = ['leaf', 'timstreams', 'ppvst', 'pitsport', 'daddylive', 'golf', 'echo', 'delta', 'vavoo'];
    if ((!isTikTok || isZeroBandwidthByteRange) && reliableSources.includes(src)) {
      score += 15;
    }

    return score;
  }
}

module.exports = StreamScoringService;
