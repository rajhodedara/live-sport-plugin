'use strict';

// Verify against the LIVE server (not the file): fetch /configure, run it in
// jsdom with events, and confirm the served page has the wiring fix and live league filter.

const { JSDOM } = require('jsdom');

(async () => {
  const res = await fetch('http://127.0.0.1:7000/configure');
  const html = await res.text();
  const optRes = await fetch('http://127.0.0.1:7000/live-league-options.js');
  const optScript = await optRes.text();

  const hasLangListener = /languagesInput\.addEventListener/.test(html);
  const hasFilterListener = /replayFilterSelect\.addEventListener/.test(html);
  console.log('served page has languages listener   :', hasLangListener);
  console.log('served page has replayFilter listener:', hasFilterListener);

  function makeDom(url, pageHtml) {
    // Inject shared options script directly so JSDOM executes it synchronously before page script
    const inlinedHtml = (pageHtml || html).replace(
      '<script src="/live-league-options.js"></script>',
      `<script>${optScript}</script>`
    );
    return new JSDOM(inlinedHtml, {
      url: url || 'http://192.168.0.123:7000/configure',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
      }
    });
  }

  const dom = makeDom();
  const w = dom.window;

  const seg = (win = w) => {
    const m = win.document.getElementById('manualUrl').value.match(/\/([A-Za-z0-9_-]+)\/manifest\.json/);
    if (!m) return null;
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return JSON.parse(Buffer.from(b, 'base64').toString('utf-8'));
  };

  const raw = (win = w) => win.document.getElementById('manualUrl').value;

  // 1. Existing personalization wiring checks
  const start = raw();
  const lang = w.document.getElementById('languages');
  lang.value = 'Spanish';
  lang.dispatchEvent(new w.Event('input', { bubbles: true }));
  const afterEs = raw();

  lang.value = 'Arabic';
  lang.dispatchEvent(new w.Event('input', { bubbles: true }));
  const afterAr = raw();

  const sel = w.document.getElementById('replayFilter');
  sel.value = 'mainstream';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  const finalCfg = seg();

  const okPersonalization = start !== afterEs && afterEs !== afterAr && finalCfg.languages === 'Arabic' && finalCfg.replayFilter === 'mainstream';
  console.log('Personalization wiring check:', okPersonalization ? 'OK' : 'FAILED');
  if (!okPersonalization) process.exit(1);

  // Reset languages & replayFilter for clean testing of liveLeagues
  lang.value = '';
  lang.dispatchEvent(new w.Event('input', { bubbles: true }));
  sel.value = 'all';
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));

  // 2. Interaction 1: Open /configure (fresh)
  // All curated checkboxes and Other checked, summary says "All selected", decoded manifest config has no liveLeagues
  const freshDom = makeDom();
  const fw = freshDom.window;
  const allCuratedCbs = fw.document.querySelectorAll('#liveLeagueGroupsContainer input[type="checkbox"]');
  const allCuratedChecked = Array.from(allCuratedCbs).every(cb => cb.checked);
  const otherCb = fw.document.getElementById('liveLeagueOther');
  const summaryCount = fw.document.getElementById('liveLeaguesCount').textContent;
  const freshCfg = seg(fw);
  const ok1 = allCuratedCbs.length > 0 && allCuratedChecked && otherCb.checked && summaryCount === 'All selected' && (!freshCfg || freshCfg.liveLeagues === undefined);
  console.log('Interaction 1 (default state)       :', ok1 ? 'OK' : 'FAILED', { allCuratedChecked, other: otherCb.checked, summaryCount, hasLiveLeagues: Boolean(freshCfg && freshCfg.liveLeagues) });
  if (!ok1) process.exit(1);

  // 3. Interaction 2: Mainstream only replaces the selection and remains editable
  fw.document.getElementById('liveLeaguesMainstream').click();
  const mainstreamCfg = seg(fw);
  const mainstreamIds = mainstreamCfg && mainstreamCfg.liveLeagues ? mainstreamCfg.liveLeagues.ids : [];
  const okMainstream = mainstreamIds.includes('epl') &&
    mainstreamIds.includes('nba') &&
    !mainstreamIds.includes('laliga-2') &&
    !mainstreamIds.includes('2-bundesliga') &&
    mainstreamCfg.liveLeagues.other === false &&
    mainstreamCfg.liveLeagues.custom.length === 0;
  const mainstreamNba = fw.document.querySelector('#liveLeagueGroupsContainer input[value="nba"]');
  mainstreamNba.click();
  const editableAfterPreset = !seg(fw).liveLeagues.ids.includes('nba');
  console.log('Interaction 2 (mainstream preset)   :', okMainstream && editableAfterPreset ? 'OK' : 'FAILED', { mainstreamCount: mainstreamIds.length, editableAfterPreset });
  if (!okMainstream || !editableAfterPreset) process.exit(1);
  fw.document.getElementById('liveLeaguesAll').click();

  // 4. Interaction 3: Search for 'bundesliga'
  // Both Bundesliga options visible; hidden choices retain their state
  const searchInput = fw.document.getElementById('liveLeagueSearch');
  searchInput.value = 'bundesliga';
  searchInput.dispatchEvent(new fw.Event('input', { bubbles: true }));
  const b1Item = fw.document.querySelector('.league-chip-item[data-label="bundesliga"]');
  const b2Item = fw.document.querySelector('.league-chip-item[data-label="2 bundesliga"]');
  const eplItem = fw.document.querySelector('.league-chip-item[data-label="premier league"]');
  const ok2 = b1Item && !b1Item.hidden && b2Item && !b2Item.hidden && eplItem && eplItem.hidden && eplItem.querySelector('input').checked === true;
  console.log('Interaction 3 (search bundesliga)   :', ok2 ? 'OK' : 'FAILED', { b1Visible: !b1Item.hidden, b2Visible: !b2Item.hidden, eplHidden: eplItem.hidden, eplChecked: eplItem.querySelector('input').checked });
  if (!ok2) process.exit(1);

  // Clear search for subsequent tests
  searchInput.value = '';
  searchInput.dispatchEvent(new fw.Event('input', { bubbles: true }));

  // 4. Interaction 3: Clear, then check Premier League
  // Decoded install config has { ids: ['epl'], custom: [], other: false }
  fw.document.getElementById('liveLeaguesClear').click();
  const eplCb = fw.document.querySelector('#liveLeagueGroupsContainer input[value="epl"]');
  eplCb.checked = true;
  eplCb.dispatchEvent(new fw.Event('change', { bubbles: true }));
  const cfg3 = seg(fw);
  const ok3 = cfg3 && cfg3.liveLeagues && JSON.stringify(cfg3.liveLeagues) === JSON.stringify({ ids: ['epl'], custom: [], other: false });
  console.log('Interaction 3 (clear + check epl)   :', ok3 ? 'OK' : 'FAILED', cfg3 ? cfg3.liveLeagues : null);
  if (!ok3) process.exit(1);

  // 5. Interaction 4: Add Copa do Brasil and Copa d'Été, Série A, reopen encoded URL
  // Both names and Premier League restored, preserving punctuation; summary shows "3 selected"
  const customInput = fw.document.getElementById('customLeagueInput');
  const addBtn = fw.document.getElementById('addCustomLeagueBtn');
  customInput.value = 'Copa do Brasil';
  addBtn.click();
  customInput.value = "Copa d\u2019\u00c9t\u00e9, S\u00e9rie A";
  addBtn.click();
  const cfg4 = seg(fw);
  console.log('Encoded custom leagues:', cfg4.liveLeagues);

  const base64Str = Buffer.from(JSON.stringify(cfg4)).toString('base64');
  const encodedSegment = base64Str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const reopenDom = makeDom(`http://192.168.0.123:7000/${encodedSegment}/configure`);
  const rw = reopenDom.window;
  const rwEpl = rw.document.querySelector('#liveLeagueGroupsContainer input[value="epl"]');
  const rwCount = rw.document.getElementById('liveLeaguesCount').textContent;
  const rwChips = Array.from(rw.document.querySelectorAll('#customLeagueChips li')).map(li => li.childNodes[0].textContent);
  const ok4 = rwEpl && rwEpl.checked && rwCount === '3 selected' && rwChips.includes('Copa do Brasil') && rwChips.includes("Copa d\u2019\u00c9t\u00e9, S\u00e9rie A");
  console.log('Interaction 4 (reopen encoded URL)  :', ok4 ? 'OK' : 'FAILED', { rwEplChecked: rwEpl.checked, rwCount, rwChips });
  if (!ok4) process.exit(1);

  // 6. Interaction 5: Add same custom name again with different casing, or add EPL
  // No duplicate; the latter points to Premier League
  const initialChipCount = rw.document.querySelectorAll('#customLeagueChips li').length;
  const rwCustomInput = rw.document.getElementById('customLeagueInput');
  const rwAddBtn = rw.document.getElementById('addCustomLeagueBtn');
  rwCustomInput.value = 'copa do brasil'; // lower case duplicate
  rwAddBtn.click();
  const chipCountAfterDupe = rw.document.querySelectorAll('#customLeagueChips li').length;

  rwCustomInput.value = 'EPL'; // curated alias
  rwAddBtn.click();
  const chipCountAfterCurated = rw.document.querySelectorAll('#customLeagueChips li').length;
  const ok5 = initialChipCount === chipCountAfterDupe && chipCountAfterDupe === chipCountAfterCurated && rwEpl.checked;
  console.log('Interaction 5 (duplicate rejection) :', ok5 ? 'OK' : 'FAILED', { initialChipCount, chipCountAfterDupe, chipCountAfterCurated });
  if (!ok5) process.exit(1);

  // 7. Interaction 6: Clear all
  // Decoded config has { ids: [], custom: [], other: false } and a live-catalog warning appears in review
  rw.document.getElementById('liveLeaguesClear').click();
  const cfg6 = seg(rw);
  const reviewHtml = rw.document.getElementById('configSummary').innerHTML;
  const hasWarning = reviewHtml.includes('No live fixtures will appear. Select a league to show live fixtures.');
  const ok6 = cfg6 && cfg6.liveLeagues && JSON.stringify(cfg6.liveLeagues) === JSON.stringify({ ids: [], custom: [], other: false }) && hasWarning;
  console.log('Interaction 6 (clear all + warning) :', ok6 ? 'OK' : 'FAILED', { liveLeagues: cfg6 ? cfg6.liveLeagues : null, hasWarning });
  if (!ok6) process.exit(1);

  // 8. Interaction 7: Select all after Clear
  // Default restored and liveLeagues omitted
  rw.document.getElementById('liveLeaguesAll').click();
  const cfg7 = seg(rw);
  const count7 = rw.document.getElementById('liveLeaguesCount').textContent;
  const ok7 = count7 === 'All selected' && (!cfg7 || cfg7.liveLeagues === undefined);
  console.log('Interaction 7 (select all after clr):', ok7 ? 'OK' : 'FAILED', { count7, hasLiveLeagues: Boolean(cfg7 && cfg7.liveLeagues) });
  if (!ok7) process.exit(1);

  // 9. Interaction 8: Customize live leagues
  // Collections links still carry existing replay settings and omit liveLeagues
  rw.document.getElementById('languages').value = 'French';
  rw.document.getElementById('languages').dispatchEvent(new rw.Event('input', { bubbles: true }));
  rw.document.getElementById('replayFilter').value = 'mainstream';
  rw.document.getElementById('replayFilter').dispatchEvent(new rw.Event('change', { bubbles: true }));
  rw.document.getElementById('liveLeaguesClear').click();
  rw.document.querySelector('#liveLeagueGroupsContainer input[value="epl"]').click();

  const manifestVal = rw.document.getElementById('manualUrl').value;
  const colVal = rw.document.getElementById('collectionsUrlInput').value;
  const decodedManifest = seg(rw);

  // Decode collections config segment if present
  let decodedColCfg = null;
  const colMatch = colVal.match(/\/([A-Za-z0-9_-]+)\/collections\.json/);
  if (colMatch) {
    let b = colMatch[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    decodedColCfg = JSON.parse(Buffer.from(b, 'base64').toString('utf-8'));
  }

  const ok8 = decodedManifest && decodedManifest.liveLeagues && (!decodedColCfg || decodedColCfg.liveLeagues === undefined) && colVal.includes('replayFilter=mainstream') && colVal.includes('languages=French');
  console.log('Interaction 8 (collections isolation):', ok8 ? 'OK' : 'FAILED', { manifestHasLL: Boolean(decodedManifest && decodedManifest.liveLeagues), colHasLL: Boolean(decodedColCfg && decodedColCfg.liveLeagues), colVal });
  if (!ok8) process.exit(1);

  console.log('');
  console.log('ALL INTERACTIONS PASSED SUCCESSFULLY!');
  process.exit(0);
})();
