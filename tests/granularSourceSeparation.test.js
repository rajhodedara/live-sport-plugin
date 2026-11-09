'use strict';

const fs = require('fs');
const path = require('path');
const { selectSources, KNOWN_LIVE_SOURCES, KNOWN_REPLAY_SOURCES } = require('../src/streams');

describe('Granular Live & Replay Source Separation', () => {
  const sampleSources = [
    { source: 'daddylive', id: 'dl_1' },
    { source: 'cdnlive', id: 'cl_1' },
    { source: 'streamedpk', id: 'spk_1' },
    { source: 'soccerfull', id: 'sf_1' },
    { source: 'fullraces', id: 'fr_1' },
    { source: 'replayzone', id: 'rz_1' }
  ];

  describe('selectSources with liveSources', () => {
    test('restricting liveSources filters live sources but preserves all replay sources', () => {
      const config = { liveSources: 'daddylive' };
      const selected = selectSources(sampleSources, config);
      const names = selected.map(s => s.source);

      expect(names).toContain('daddylive');
      expect(names).not.toContain('cdnlive');
      expect(names).not.toContain('streamedpk');

      // Replay sources should remain untouched
      expect(names).toContain('soccerfull');
      expect(names).toContain('fullraces');
      expect(names).toContain('replayzone');
    });

    test('setting liveSources to "none" strips all live sources and retains replays', () => {
      const config = { liveSources: 'none' };
      const selected = selectSources(sampleSources, config);
      const names = selected.map(s => s.source);

      expect(names).not.toContain('daddylive');
      expect(names).not.toContain('cdnlive');
      expect(names).not.toContain('streamedpk');
      expect(names).toContain('soccerfull');
      expect(names).toContain('fullraces');
      expect(names).toContain('replayzone');
    });
  });

  describe('selectSources with replaySources', () => {
    test('restricting replaySources filters replay sources but preserves all live sources', () => {
      const config = { replaySources: 'soccerfull' };
      const selected = selectSources(sampleSources, config);
      const names = selected.map(s => s.source);

      // Live sources should remain untouched
      expect(names).toContain('daddylive');
      expect(names).toContain('cdnlive');
      expect(names).toContain('streamedpk');

      // Only soccerfull should remain from replays
      expect(names).toContain('soccerfull');
      expect(names).not.toContain('fullraces');
      expect(names).not.toContain('replayzone');
    });

    test('setting replaySources to "none" strips all replay sources and retains live sources', () => {
      const config = { replaySources: 'none' };
      const selected = selectSources(sampleSources, config);
      const names = selected.map(s => s.source);

      expect(names).toContain('daddylive');
      expect(names).toContain('cdnlive');
      expect(names).toContain('streamedpk');
      expect(names).not.toContain('soccerfull');
      expect(names).not.toContain('fullraces');
      expect(names).not.toContain('replayzone');
    });
  });

  describe('selectSources with both liveSources and replaySources', () => {
    test('strictly filters both dimensions simultaneously', () => {
      const config = {
        liveSources: 'daddylive,streamedpk',
        replaySources: 'fullraces'
      };
      const selected = selectSources(sampleSources, config);
      const names = selected.map(s => s.source);

      expect(names).toContain('daddylive');
      expect(names).toContain('streamedpk');
      expect(names).not.toContain('cdnlive');

      expect(names).toContain('fullraces');
      expect(names).not.toContain('soccerfull');
      expect(names).not.toContain('replayzone');
    });

    test('handles embedst and embedindia aliases through streamedpk toggle', () => {
      const sourcesWithAliases = [
        { source: 'embedindia', id: 'ei_1' },
        { source: 'embedst', id: 'es_1' },
        { source: 'daddylive', id: 'dl_1' }
      ];
      const withSpk = selectSources(sourcesWithAliases, { liveSources: 'streamedpk' });
      expect(withSpk.map(s => s.source)).toEqual(expect.arrayContaining(['embedindia', 'embedst']));
      expect(withSpk.map(s => s.source)).not.toContain('daddylive');

      const withoutSpk = selectSources(sourcesWithAliases, { liveSources: 'daddylive' });
      expect(withoutSpk.map(s => s.source)).toEqual(['daddylive']);
    });
  });

  describe('Backward compatibility with legacy config.sources', () => {
    test('legacy sources filter applies across both live and replay sources', () => {
      const config = { sources: 'daddylive,soccerfull' };
      const selected = selectSources(sampleSources, config);
      const names = selected.map(s => s.source);

      expect(names).toEqual(expect.arrayContaining(['daddylive', 'soccerfull']));
      expect(names).not.toContain('cdnlive');
      expect(names).not.toContain('fullraces');
    });

    test('legacy sources="none" strips all standard fallbacks but preserves yaml_', () => {
      const sourcesWithYaml = [
        { source: 'daddylive', id: 'dl_1' },
        { source: 'yaml_custom', id: 'yc_1' }
      ];
      const selected = selectSources(sourcesWithYaml, { sources: 'none' });
      expect(selected.map(s => s.source)).toEqual(['yaml_custom']);
    });

    test('unconfigured returns all known fallbacks in prioritized order', () => {
      const selected = selectSources(sampleSources, null);
      expect(selected.length).toBe(sampleSources.length);
    });
  });

  describe('Configure page markup & wiring validation', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8');

    test('exposes independent live and replay grid containers within sourcesGrid', () => {
      expect(html).toContain('id="sourcesGrid"');
      expect(html).toContain('id="liveSourcesGrid"');
      expect(html).toContain('id="replaySourcesGrid"');
      expect(html).toContain('id="replaySourcesContainer"');
    });

    test('replay sources container lives inside personalization panel and syncs with replayFilter', () => {
      const prefsPanel = html.slice(html.indexOf('aria-labelledby="prefs-h"'), html.indexOf('aria-labelledby="collections-h"'));
      expect(prefsPanel).toContain('id="replayFilter"');
      expect(prefsPanel).toContain('id="replaySourcesContainer"');
      expect(html).toMatch(/syncReplayVisibility/);
      expect(html).toMatch(/replaySourcesContainer\.style\.display\s*=\s*isHidden\s*\?\s*'none'\s*:\s*'block'/);
    });

    test('contains all expected live source checkboxes', () => {
      for (const src of ['streamedpk', 'daddylive', 'cdnlive', 'streamsports99', 'timstreams', 'damitv', 'ppvst', 'sktech']) {
        expect(html).toMatch(new RegExp(`<input[^>]*value="${src}"`));
      }
    });

    test('contains all expected replay source checkboxes', () => {
      for (const src of ['replayzone', 'soccerfull', 'fullraces', 'basketballvideo', 'nflvideo', 'hockeyreplays', 'mlblive', 'livetv']) {
        expect(html).toMatch(new RegExp(`<input[^>]*value="${src}"`));
      }
    });

    test('exposes Select All and Select None quick action buttons for both grids', () => {
      expect(html).toContain('id="selectAllLive"');
      expect(html).toContain('id="selectNoneLive"');
      expect(html).toContain('id="selectAllReplays"');
      expect(html).toContain('id="selectNoneReplays"');
    });

    test('script references liveSources and replaySources during serialization and restoration', () => {
      expect(html).toMatch(/config\.liveSources\s*=/);
      expect(html).toMatch(/config\.replaySources\s*=/);
      expect(html).toMatch(/existingConfig\.liveSources/);
      expect(html).toMatch(/existingConfig\.replaySources/);
    });
  });
});
