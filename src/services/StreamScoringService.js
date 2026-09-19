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
    if (title.includes('1080p') || streamEntity.resolution === '1920x1080') {
      score += 20;
    } else if (title.includes('720p') || streamEntity.resolution === '1280x720') {
      score += 10;
    } else if (title.includes('540p') || title.includes('SD')) {
      score -= 5;
    }

    // 3. Source Reliability
    // Some sources are known to buffer less.
    const reliableSources = ['admin', 'echo', 'delta', 'golf'];
    if (reliableSources.includes(sourceName)) {
      score += 15;
    } else if (sourceName === 'timstreams') {
      score += 5;
    }

    return score;
  }
}

module.exports = StreamScoringService;
