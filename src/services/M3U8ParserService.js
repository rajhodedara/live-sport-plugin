const { request } = require('undici');
const m3u8Parser = require('m3u8-parser');

class M3U8ParserService {
  constructor() {}

  /**
   * Fetches an m3u8 playlist, parses it, and returns the highest quality stream details
   */
  async getHighestQuality(manifestUrl) {
    try {
      const res_req = await request(manifestUrl, { headersTimeout: 5000, bodyTimeout: 5000 });
        const res = {
          data: await res_req.body.text()
        };
      const parser = new m3u8Parser.Parser();
      parser.push(res.data);
      parser.end();

      const playlists = parser.manifest.playlists || [];
      if (playlists.length === 0) return null;

      // Sort by bandwidth descending
      playlists.sort((a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0));
      
      const best = playlists[0];
      const resolution = best.attributes.RESOLUTION ? `${best.attributes.RESOLUTION.width}x${best.attributes.RESOLUTION.height}` : null;
      const bitrate = best.attributes.BANDWIDTH ? Math.round(best.attributes.BANDWIDTH / 100000) / 10 + 'Mbps' : null;
      
      // Extract Audio Languages
      let languages = [];
      const audioGroupId = best.attributes.AUDIO;
      if (audioGroupId && parser.manifest.mediaGroups && parser.manifest.mediaGroups.AUDIO) {
        const audioGroup = parser.manifest.mediaGroups.AUDIO[audioGroupId];
        if (audioGroup) {
          for (const key of Object.keys(audioGroup)) {
            const track = audioGroup[key];
            if (track.language) {
              languages.push(track.language.toUpperCase());
            } else if (track.name) {
              // Sometimes they use NAME="English" instead of LANGUAGE="en"
              languages.push(track.name.substring(0,2).toUpperCase());
            }
          }
        }
      }
      // Deduplicate
      languages = [...new Set(languages)];

      let label = '';
      if (resolution) label += resolution;
      if (bitrate) label += (label ? ' @ ' : '') + bitrate;
      if (languages.length > 0) label += ` [${languages.join(', ')}]`;

      let uri = best.uri;
      try {
        uri = new URL(best.uri, manifestUrl).href;
      } catch (e) {
        // Keep the raw URI if it cannot be resolved
      }

      return {
        resolution,
        bitrate,
        languages,
        label: label || 'Auto',
        uri
      };
    } catch (e) {
      console.error('[M3U8Parser] Error parsing manifest:', e.message);
      return null;
    }
  }

  /**
   * Synchronously parse already fetched manifest text to extract maximum resolution, FPS, and bitrate.
   */
  parseManifestText(manifestText) {
    if (!manifestText || !manifestText.includes('#EXT')) return null;
    try {
      const parser = new m3u8Parser.Parser();
      parser.push(manifestText);
      parser.end();

      const playlists = parser.manifest.playlists || [];
      if (playlists.length === 0) return null;

      // Sort by bandwidth descending
      playlists.sort((a, b) => (b.attributes.BANDWIDTH || 0) - (a.attributes.BANDWIDTH || 0));

      const best = playlists[0];
      let height = null;
      if (best.attributes && best.attributes.RESOLUTION) {
        height = best.attributes.RESOLUTION.height;
      }

      const frameRate = best.attributes && best.attributes['FRAME-RATE'] 
        ? Math.round(best.attributes['FRAME-RATE']) 
        : null;
      const bandwidth = best.attributes && best.attributes.BANDWIDTH ? best.attributes.BANDWIDTH : 0;

      let qualityTag = '';
      if (height) {
        qualityTag = `${height}p`;
        if (frameRate && frameRate >= 45) {
          qualityTag += `${frameRate}`;
        }
      } else {
        qualityTag = 'HD';
      }

      let bitrateTag = '';
      if (bandwidth > 0) {
        if (bandwidth >= 1000000) {
          bitrateTag = `${(bandwidth / 1000000).toFixed(1)} Mbps`;
        } else {
          bitrateTag = `${Math.round(bandwidth / 1000)} kbps`;
        }
      }

      let fullQuality = qualityTag;
      if (bitrateTag) {
        fullQuality += ` · ${bitrateTag}`;
      }

      return {
        resolution: height ? `${best.attributes.RESOLUTION.width}x${height}` : null,
        qualityTag,
        bitrateTag,
        frameRate,
        fullQuality
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Synchronously parse a media playlist for speed-probe inputs: the
   * playlist's target duration and its first segment (URI + EXTINF duration).
   * Media playlists (single rendition, no #EXT-X-STREAM-INF) are what our
   * providers actually serve, so this — not parseManifestText — is the input
   * the speed probe relies on.
   */
  parseMediaPlaylistInfo(manifestText) {
    if (!manifestText || !manifestText.includes('#EXT')) return null;
    try {
      const parser = new m3u8Parser.Parser();
      parser.push(manifestText);
      parser.end();

      const segments = parser.manifest.segments || [];
      const firstSegment = segments.find((seg) => seg && seg.uri);
      if (!firstSegment) {
        return {
          targetDuration: parser.manifest.targetDuration || null,
          firstSegmentUri: null,
          firstSegmentDuration: null,
        };
      }

      return {
        targetDuration: parser.manifest.targetDuration || null,
        firstSegmentUri: firstSegment.uri,
        firstSegmentDuration: firstSegment.duration || null,
      };
    } catch (e) {
      return null;
    }
  }
}

module.exports = M3U8ParserService;
