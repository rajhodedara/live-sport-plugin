'use strict';

// Verify against the LIVE server (not the file): fetch /configure, run it in
// jsdom with events, and confirm the served page has the wiring fix.

const { JSDOM } = require('jsdom');

(async () => {
  const res = await fetch('http://127.0.0.1:7000/configure');
  const html = await res.text();

  const hasLangListener = /languagesInput\.addEventListener/.test(html);
  const hasFilterListener = /replayFilterSelect\.addEventListener/.test(html);
  console.log('served page has languages listener   :', hasLangListener);
  console.log('served page has replayFilter listener:', hasFilterListener);

  const dom = new JSDOM(html, {
    url: 'http://192.168.0.123:7000/configure',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const w = dom.window;

  const seg = () => {
    const m = w.document.getElementById('manualUrl').value.match(/\/([A-Za-z0-9_-]+)\/manifest\.json/);
    if (!m) return null;
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return JSON.parse(Buffer.from(b, 'base64').toString('utf-8'));
  };

  const raw = () => w.document.getElementById('manualUrl').value;

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

  console.log('');
  console.log('no-pref  :', start.split('/').slice(-2)[0]);
  console.log('spanish  :', afterEs.split('/').slice(-2)[0]);
  console.log('arabic   :', afterAr.split('/').slice(-2)[0]);
  console.log('final cfg:', JSON.stringify(finalCfg));
  console.log('');

  const ok = start !== afterEs && afterEs !== afterAr && finalCfg.languages === 'Arabic' && finalCfg.replayFilter === 'mainstream';
  console.log(ok ? 'LIVE PAGE: OK — every change produces a distinct, correct URL'
                 : 'LIVE PAGE: STILL BROKEN');
  process.exit(ok ? 0 : 1);
})();
