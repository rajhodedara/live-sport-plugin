class StreamEntity {
  constructor(data = {}) {
    this.name = data.name || 'Unknown Proxy';
    this.title = data.title || 'Unknown Stream';
    
    if (data.url) {
      this.url = data.url;
    }
    if (data.externalUrl) {
      this.externalUrl = data.externalUrl;
    }

    this.resolution = data.resolution || null;
    this.bitrate = data.bitrate || null;
    this.score = data.score || 0;
    
    if (data.behaviorHints) {
      this.behaviorHints = data.behaviorHints;
    }
    if (data.clearkey) {
      this.clearkey = data.clearkey;
    }
    if (data.language) {
      this.language = data.language;
    }
    if (data.quality) {
      this.quality = data.quality;
    }
    if (data.country) {
      this.country = data.country;
    }
    if (data.countryCode) {
      this.countryCode = data.countryCode;
    }
    if (data.countryFlag) {
      this.countryFlag = data.countryFlag;
    }
    if (data.canonicalChannel) {
      this.canonicalChannel = data.canonicalChannel;
    }
    if (data.channelName) {
      this.channelName = data.channelName;
    }
    if (data.sourceName) {
      this.sourceName = data.sourceName;
    }
    if (data._source) {
      this._source = data._source;
    }
    if (data.isBackup !== undefined) {
      this.isBackup = data.isBackup;
    }
    if (data.isTimeshift !== undefined) {
      this.isTimeshift = data.isTimeshift;
    }
    if (data.isCondensed !== undefined) {
      this.isCondensed = data.isCondensed;
    }
    if (data.speedScore !== undefined) {
      this.speedScore = data.speedScore;
    }
    if (data.isTikTok !== undefined) {
      this.isTikTok = data.isTikTok;
    }
    if (data.cluster !== undefined) {
      this.cluster = data.cluster;
    }
    if (data.serverCluster !== undefined) {
      this.serverCluster = data.serverCluster;
    }
    if (data._streamSource !== undefined) {
      this._streamSource = data._streamSource;
    }
    if (data._kafkaMatchMode !== undefined) {
      this._kafkaMatchMode = data._kafkaMatchMode;
    }
    if (data._kafkaEventScore !== undefined) {
      this._kafkaEventScore = data._kafkaEventScore;
    }
    if (data._kafkaVerifiedHeight !== undefined) {
      this._kafkaVerifiedHeight = data._kafkaVerifiedHeight;
    }
    if (data._kafkaMeasuredBitrateBps !== undefined) {
      this._kafkaMeasuredBitrateBps = data._kafkaMeasuredBitrateBps;
    }
    if (data._isChannelFallback !== undefined) {
      this._isChannelFallback = data._isChannelFallback;
    }
  }
}

module.exports = StreamEntity;
