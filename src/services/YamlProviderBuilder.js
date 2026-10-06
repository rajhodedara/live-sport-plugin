const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cheerio = require('cheerio');
const { request } = require('undici');
const BaseProvider = require('../providers/BaseProvider');
const MatchEntity = require('../domain/MatchEntity');
const StreamEntity = require('../domain/StreamEntity');

class GenericYamlProvider extends BaseProvider {
  constructor(opts, config) {
    super(opts);
    this.name = config.name;
    this.config = config;

    this.fetchData = this.circuitBreaker.wrapSync(`${this.name}_fetch`, async () => {
      const res_req = await request(this.config.baseUrl, { headersTimeout: 10000, bodyTimeout: 10000 });
    const res = {
      data: await res_req.body.text().then(t => { try { return JSON.parse(t); } catch(e) { return t; } })
    };
      return res.data;
    });
  }

  async getMatches() {
    const matches = [];
    try {
      const html = await this.fetchData.fire();
      if (!html) return [];

      const $ = cheerio.load(html);
      
      $(this.config.selectors.matches).each((i, el) => {
        const title = $(el).find(this.config.selectors.title).text().trim();
        if (!title) return;

        let linkAttr = this.config.selectors.link.split('->').map(s => s.trim());
        let link = '';
        if (linkAttr.length === 2) {
           link = $(el).find(linkAttr[0]).attr(linkAttr[1]);
        } else {
           link = $(el).find(this.config.selectors.link).attr('href');
        }

        const timeText = $(el).find(this.config.selectors.time).text().trim();
        // Fallback generic parsing
        const date = Date.now().toString();

        matches.push(new MatchEntity({
          id: `yaml_${this.name}_${i}`,
          title: title,
          category: this.normalizeCategory(this.config.defaultCategory || 'other'),
          date: date,
          popular: '0',
          sources: [{ source: 'yaml_' + this.name, id: link, url: link }]
        }));
      });

    } catch (error) {
      console.error(`[${this.name}] YAML Provider Error:`, error.message);
    }
    return matches;
  }

  async resolveStream(sourceId, matchCategory, matchTitle) {
    // For simple YAML scrapers, we just return the link as an external player
    // Building a generic m3u8 extractor in YAML is too complex for this phase,
    // so we fallback to Nuvio Web Player.
    const watchUrl = sourceId.startsWith('http') ? sourceId : `${this.config.baseUrl.replace(/\/$/, '')}${sourceId.startsWith('/') ? '' : '/'}${sourceId}`;
    return [new StreamEntity({
      name: 'Nuvio Web Player',
      title: `${this.name} (${matchTitle})`,
      externalUrl: watchUrl
    })];
  }
}

class YamlProviderBuilder {
  constructor() {}

  buildProviders(container, circuitBreaker) {
    const yamlDir = path.join(__dirname, '..', 'providers', 'yaml');
    if (!fs.existsSync(yamlDir)) {
      fs.mkdirSync(yamlDir, { recursive: true });
    }

    const files = fs.readdirSync(yamlDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    const generatedProviders = [];

    files.forEach(file => {
      try {
        const fileContents = fs.readFileSync(path.join(yamlDir, file), 'utf8');
        const config = yaml.load(fileContents);
        
        if (config && config.name && config.baseUrl && config.selectors && typeof config.selectors.matches === 'string' && typeof config.selectors.title === 'string' && typeof config.selectors.link === 'string') {
          const providerInstance = new GenericYamlProvider({ circuitBreaker }, config);
          generatedProviders.push(providerInstance);
          console.log(`[YamlProviderBuilder] Successfully loaded YAML provider: ${config.name}`);
        }
      } catch (e) {
        console.error(`[YamlProviderBuilder] Failed to parse ${file}:`, e.message);
      }
    });

    return generatedProviders;
  }
}

module.exports = YamlProviderBuilder;
