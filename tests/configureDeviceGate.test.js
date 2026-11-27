'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'configure.html'), 'utf8');

function extractInlineScripts(source) {
  const navMarker = '<script src="/nav-toggle.js"></script>';
  const idx = source.indexOf(navMarker);
  if (idx === -1) throw new Error('Could not find nav-toggle.js marker in configure.html');
  const tail = source.slice(idx + navMarker.length);
  const scripts = [...tail.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length < 2) throw new Error('Expected at least 2 inline scripts after nav-toggle.js');
  return scripts;
}

const inlineScripts = extractInlineScripts(html);

function createClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...tokens) => tokens.forEach((t) => set.add(t)),
    remove: (...tokens) => tokens.forEach((t) => set.delete(t)),
    contains: (t) => set.has(t),
    toggle: (t, force) => {
      if (force === undefined) {
        if (set.has(t)) { set.delete(t); return false; }
        set.add(t); return true;
      }
      if (force) { set.add(t); return true; }
      set.delete(t); return false;
    },
    toString: () => Array.from(set).join(' ')
  };
}

function createStubElement(tagName, opts = {}) {
  const listeners = new Map();
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    id: opts.id || '',
    type: opts.type || '',
    value: opts.value !== undefined ? opts.value : '',
    checked: !!opts.checked,
    disabled: !!opts.disabled,
    hidden: !!opts.hidden,
    inert: !!opts.inert,
    open: false,
    href: opts.href || '',
    textContent: opts.textContent || '',
    innerHTML: '',
    style: {},
    dataset: Object.assign({}, opts.dataset),
    classList: createClassList(opts.classes || []),
    parentNode: null,
    children,
    _listeners: listeners,
    _attrs: attrs,
    _focused: false,
    _scrolledIntoView: false,
    set className(v) {
      this.classList = createClassList(String(v || '').split(/\s+/).filter(Boolean));
    },
    get className() {
      return this.classList.toString();
    },
    setAttribute(k, v) {
      const val = String(v);
      attrs.set(k, val);
      if (k === 'href') this.href = val;
      if (k === 'hidden') this.hidden = true;
      if (k === 'inert') this.inert = true;
      if (k === 'disabled') this.disabled = true;
    },
    getAttribute(k) {
      if (k === 'href') return attrs.has('href') ? attrs.get('href') : this.href || null;
      return attrs.has(k) ? attrs.get(k) : null;
    },
    removeAttribute(k) {
      attrs.delete(k);
      if (k === 'hidden') this.hidden = false;
      if (k === 'inert') this.inert = false;
      if (k === 'disabled') this.disabled = false;
    },
    hasAttribute(k) {
      if (k === 'hidden') return this.hidden || attrs.has('hidden');
      if (k === 'inert') return this.inert || attrs.has('inert');
      if (k === 'disabled') return this.disabled || attrs.has('disabled');
      return attrs.has(k);
    },
    toggleAttribute(k, force) {
      const has = this.hasAttribute(k);
      const next = force !== undefined ? !!force : !has;
      if (next) this.setAttribute(k, '');
      else this.removeAttribute(k);
      return next;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(evt) {
      const event = evt || { type: 'click', target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      if (!event.target) event.target = el;
      if (!event.preventDefault) event.preventDefault = function () { this.defaultPrevented = true; };
      const arr = listeners.get(event.type) || [];
      for (const fn of arr.slice()) fn.call(el, event);
      return !event.defaultPrevented;
    },
    click() {
      const evt = { type: 'click', target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
      return this.dispatchEvent(evt);
    },
    focus() { el._focused = true; },
    select() {},
    setSelectionRange() {},
    scrollIntoView() { el._scrolledIntoView = true; },
    showModal() { el.open = true; },
    close() { el.open = false; },
    appendChild(child) {
      if (child) {
        child.parentNode = el;
        children.push(child);
      }
      return child;
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      if (child) child.parentNode = null;
      return child;
    },
    insertBefore(child) { return el.appendChild(child); },
    insertAdjacentHTML() {},
    closest(sel) {
      if (sel === '.checkbox-label' && opts._closestCheckboxLabel) return opts._closestCheckboxLabel;
      return null;
    },
    querySelector(sel) {
      if (el._queryMap && el._queryMap[sel]) return el._queryMap[sel];
      if (opts._queryMap && opts._queryMap[sel]) return opts._queryMap[sel];
      if (sel === 'a.btn') return el._manageBtn || null;
      if (sel === 'h2') return el._heading || null;
      if (sel === '.step-n') return el._stepN || null;
      if (sel === '.panel-head .step-n') return el._stepN || null;
      return null;
    },
    querySelectorAll() { return []; }
  };
  return el;
}

function createHarness({ accounts = true, search = '', pathname = '/configure', mode = 'all', fetchImpl } = {}) {
  const byId = new Map();
  const reg = (id, tag = 'div', opts = {}) => {
    const el = createStubElement(tag, { id, ...opts });
    byId.set(id, el);
    return el;
  };

  // Core install/copy/dialog elements
  reg('installBtn', 'a', { href: '#' });
  reg('barInstall', 'a', { href: '#' });
  reg('wizInstall', 'a', { href: '#', hidden: true });
  reg('openInstall', 'button');
  reg('closeInstall', 'button');
  reg('installDialog', 'dialog');
  reg('installIssues', 'div', { hidden: true });
  reg('finishIssues', 'div', { hidden: true });
  reg('copyBtn', 'button');
  reg('copyBtnLabel', 'span', { textContent: 'Copy link for Nuvio app' });
  reg('barCopy', 'button');
  reg('finishCopy', 'button');
  reg('manualUrl', 'input', { value: '' });
  reg('copyCollectionsBtn', 'button');
  reg('collectionsBtnLabel', 'span', { textContent: 'Copy JSON' });
  reg('downloadCollectionsBtn', 'a', { href: '#' });
  reg('collectionsUrlInput', 'input', { value: '' });
  reg('installStatus', 'p');
  reg('configSummary', 'ul');
  reg('finishSummary', 'ul');
  reg('progressList', 'ul');
  reg('progressBar', 'circle');
  reg('progressText', 'b');
  reg('progressRingBox', 'div');
  reg('readyHint', 'p');
  reg('barHint', 'p', { hidden: true });
  reg('heroEyebrow', 'p');
  reg('wizNav', 'div');
  reg('wizBack', 'button');
  reg('wizNext', 'button');
  reg('wizCount', 'span');

  // Device elements
  const manageBtn = createStubElement('a', { href: '/account', textContent: 'Manage devices' });
  const deviceBar = reg('deviceBar', 'div', { hidden: true });
  deviceBar._manageBtn = manageBtn;
  reg('deviceSelect', 'select');
  reg('deviceNote', 'p');

  // Form controls
  reg('teams', 'input', { value: '' });
  reg('teamSearch', 'input', { value: '' });
  reg('teamSuggest', 'ul', { hidden: true });
  reg('teamChips', 'ul');
  reg('teamsClear', 'button');
  reg('timezone', 'select', { value: 'UTC' });
  reg('replayFilter', 'select', { value: 'all' });
  reg('replaySourcesContainer', 'div');
  reg('webStreams', 'select', { value: 'enabled' });
  reg('langModeAll', 'input', { type: 'radio', checked: true });
  reg('langModeOnly', 'input', { type: 'radio', checked: false });
  reg('langModeAllLabel', 'label', { classes: ['radio-label', 'active'] });
  reg('langModeOnlyLabel', 'label', { classes: ['radio-label'] });
  reg('liveLangStatus', 'div', { hidden: true });
  reg('liveLangCount', 'span');
  reg('liveLangEnglishOnly', 'button');
  reg('liveLangClear', 'button');
  reg('liveLanguagesGrid', 'div');
  reg('liveLangCustomInput', 'input');
  reg('liveLangOptions', 'datalist');
  reg('liveLangAddBtn', 'button');
  reg('liveLangFeedback', 'p', { hidden: true });
  reg('liveLeaguesCount', 'span');
  reg('liveLeagueSearch', 'input');
  reg('liveLeaguesAll', 'button');
  reg('liveLeaguesMainstream', 'button');
  reg('liveLeaguesClear', 'button');
  reg('liveLeagueOther', 'input', { type: 'checkbox', checked: true });
  reg('customLeagueInput', 'input');
  reg('addCustomLeagueBtn', 'button');
  reg('customLeagueChips', 'ul');
  reg('customLeagueFeedback', 'p', { hidden: true });
  reg('liveLeagueLiveRegion', 'div');
  reg('liveLeagueGroupsContainer', 'div');
  reg('sportsAll', 'button');
  reg('sportsNone', 'button');
  reg('selectAllLive', 'button');
  reg('selectNoneLive', 'button');
  reg('selectAllReplays', 'button');
  reg('selectNoneReplays', 'button');

  const themeToggle = reg('themeToggle', 'button');
  themeToggle._queryMap = {
    '.ico-sun': createStubElement('svg'),
    '.ico-moon': createStubElement('svg')
  };

  // Sections and headings
  const sectionIds = ['sec-device', 'sec-sports', 'sec-teams', 'sec-sources', 'sec-prefs', 'sec-collections', 'sec-finish', 'sec-support'];
  const panels = {};
  sectionIds.forEach((id) => {
    const p = reg(id, 'section');
    p._heading = createStubElement('h2');
    p._stepN = createStubElement('span');
    p._panelBody = createStubElement('div');
    p._queryMap = { '.panel-body': p._panelBody };
    panels[id] = p;
  });
  reg('sec-device-body', 'div');
  reg('deviceGateNotice', 'div', { hidden: true });
  reg('deviceGateGoBtn', 'button');

  // Sports, live, replay checkboxes
  const makeCheckbox = (val, checked = true) => {
    const lbl = createStubElement('label', { classes: checked ? ['checkbox-label', 'active'] : ['checkbox-label'] });
    return createStubElement('input', { type: 'checkbox', value: val, checked, _closestCheckboxLabel: lbl });
  };
  const sportsCheckboxes = [makeCheckbox('football', true), makeCheckbox('basketball', true)];
  panels['sec-sports'].querySelectorAll = (sel) => (sel === 'input, select, button, textarea' ? sportsCheckboxes : []);
  const liveSourceCheckboxes = [makeCheckbox('streamedpk', true)];
  const replaySourceCheckboxes = [makeCheckbox('replayzone', true)];
  const sourceCheckboxes = [...liveSourceCheckboxes, ...replaySourceCheckboxes];

  // Stepnav links and mode buttons
  const stepNavLinks = ['sec-device', 'sec-sports', 'sec-teams', 'sec-sources', 'sec-prefs', 'sec-collections', 'sec-install'].map((id) => {
    const a = createStubElement('a', { href: '#' + id });
    a._stepN = createStubElement('span');
    a._isAccountOnly = id === 'sec-device';
    a.closest = (sel) => (sel === '[data-account-only]' && a._isAccountOnly ? a : null);
    return a;
  });
  const modeAllBtn = createStubElement('button', { dataset: { mode: 'all' } });
  const modeWizBtn = createStubElement('button', { dataset: { mode: 'wizard' } });
  const supportLinks = [createStubElement('a', { href: '#sec-support' })];

  const docEl = createStubElement('html', {
    classes: accounts ? ['accounts'] : [],
    dataset: { mode }
  });
  if (mode === 'wizard') docEl.setAttribute('data-mode', 'wizard');

  const locationCalls = { replace: [], assignHref: [] };
  const locationObj = {
    origin: 'https://sports.example.com',
    hostname: 'sports.example.com',
    pathname,
    search,
    replace(u) { locationCalls.replace.push(u); },
    get href() { return this.origin + this.pathname + this.search; },
    set href(u) { locationCalls.assignHref.push(u); }
  };

  const clipboardCalls = [];
  const navigatorObj = {
    clipboard: {
      writeText(txt) {
        clipboardCalls.push(txt);
        return Promise.resolve();
      }
    }
  };

  const fetchCalls = [];
  const defaultFetch = (url, opts) => {
    fetchCalls.push({ url, opts });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') });
  };
  const activeFetch = fetchImpl || defaultFetch;

  const storage = new Map();
  const documentObj = {
    documentElement: docEl,
    body: createStubElement('body'),
    getElementById: (id) => {
      if (byId.has(id)) return byId.get(id);
      return null;
    },
    querySelector: (sel) => {
      if (sel === '.stepnav a[href="#sec-install"]') return stepNavLinks[6];
      if (sel === '.stepnav a[aria-current]') return stepNavLinks.find((a) => a.getAttribute('aria-current')) || null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '#sportsGrid input[type="checkbox"]') return sportsCheckboxes;
      if (sel === '#liveSourcesGrid input[type="checkbox"]') return liveSourceCheckboxes;
      if (sel === '#replaySourcesGrid input[type="checkbox"]') return replaySourceCheckboxes;
      if (sel === '#liveSourcesGrid input[type="checkbox"], #replaySourcesGrid input[type="checkbox"]') return sourceCheckboxes;
      if (sel === '#liveLeagueGroupsContainer input[type="checkbox"]') return [];
      if (sel === '.stepnav a') return stepNavLinks;
      if (sel === '#modeSeg button') return [modeAllBtn, modeWizBtn];
      if (sel === 'a[href="#sec-support"]') return supportLinks;
      if (sel === '.league-group') return [];
      return [];
    },
    createElement: (tag) => createStubElement(tag),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) }),
    execCommand: () => false
  };

  const windowObj = {
    location: locationObj,
    navigator: navigatorObj,
    isSecureContext: true,
    matchMedia: () => ({ matches: false, addEventListener: null }),
    scrollTo: () => {},
    addEventListener: () => {},
    fetch: (url, opts) => {
      fetchCalls.push({ url, opts });
      return activeFetch(url, opts);
    }
  };
  windowObj.window = windowObj;

  const context = vm.createContext({
    window: windowObj,
    document: documentObj,
    navigator: navigatorObj,
    location: locationObj,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v))
    },
    fetch: windowObj.fetch,
    URLSearchParams,
    Intl,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    JSON,
    Math,
    Date,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    encodeURIComponent,
    decodeURIComponent,
    escape: (s) => s,
    unescape: (s) => s,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console
  });

  vm.runInContext(inlineScripts[0], context);
  vm.runInContext(inlineScripts[1], context);

  return {
    context,
    window: windowObj,
    document: documentObj,
    byId,
    panels,
    stepNavLinks,
    modeAllBtn,
    modeWizBtn,
    supportLinks,
    sportsCheckboxes,
    clipboardCalls,
    fetchCalls,
    locationCalls
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('Configure device prerequisite — Task 1: initialization, URLs, and action guards', () => {
  test('account mode starts locked synchronously before bootstrap fetch resolves and exposes no generic/base64 URLs', () => {
    const provDef = deferred();
    const h = createHarness({
      accounts: true,
      fetchImpl: (url) => {
        if (url === '/api/auth/providers') return provDef.promise;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
    });

    expect(h.window.__accountsOn).toBe(true);
    expect(typeof h.context.isDeviceSetupReady).toBe('function');
    expect(h.context.isDeviceSetupReady()).toBe(false);
    expect(h.byId.get('manualUrl').value).toBe('');
    expect(h.byId.get('collectionsUrlInput').value).toBe('');
    expect(h.byId.get('installBtn').getAttribute('href')).toBe('#');
    expect(h.byId.get('barInstall').getAttribute('href')).toBe('#');
    expect(h.byId.get('wizInstall').getAttribute('href')).toBe('#');
    expect(h.byId.get('downloadCollectionsBtn').getAttribute('href')).toBe('#');
    expect(h.byId.get('installBtn').getAttribute('aria-disabled')).toBe('true');
    expect(h.byId.get('copyBtn').getAttribute('aria-disabled')).toBe('true');
  });

  test('empty device list keeps setup locked and publishes no links', async () => {
    const h = createHarness({
      accounts: true,
      fetchImpl: (url) => {
        if (url === '/api/auth/providers') return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true, providers: ['google'] }) });
        if (url === '/api/auth/devices') return Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [] }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
    });
    await flushMicrotasks();

    expect(h.context.isDeviceSetupReady()).toBe(false);
    expect(h.byId.get('manualUrl').value).toBe('');
    expect(h.byId.get('collectionsUrlInput').value).toBe('');
    expect(h.byId.get('installBtn').getAttribute('href')).toBe('#');
  });

  test('failed providers/devices/detail requests (401/404/network/missing manifestUrl) keep setup locked with recovery message', async () => {
    for (const scenario of ['providers-reject', 'devices-401', 'detail-404', 'detail-no-url']) {
      const h = createHarness({
        accounts: true,
        search: scenario.startsWith('detail') ? '?device=dev1' : '',
        fetchImpl: (url) => {
          if (url === '/api/auth/providers') {
            if (scenario === 'providers-reject') return Promise.reject(new Error('network'));
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true, providers: ['google'] }) });
          }
          if (url === '/api/auth/devices') {
            if (scenario === 'devices-401') return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'dev1', name: 'Living Room' }] }) });
          }
          if (url === '/api/auth/devices/dev1') {
            if (scenario === 'detail-404') return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
            if (scenario === 'detail-no-url') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'dev1', config: {} }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
      });
      await flushMicrotasks();

      expect(h.window.__accountsOn).toBe(true);
      expect(h.context.isDeviceSetupReady()).toBe(false);
      expect(h.byId.get('manualUrl').value).toBe('');
      expect(h.byId.get('installBtn').getAttribute('href')).toBe('#');
      expect(h.byId.get('deviceBar').hidden).toBe(false);
      expect(h.byId.get('deviceNote').textContent.length).toBeGreaterThan(0);
    }
  });

  test('guarded handlers (openInstall, copyBtn, barCopy, finishCopy, copyCollectionsBtn, downloadCollectionsBtn) do nothing while locked and focus device step', () => {
    const h = createHarness({ accounts: true, fetchImpl: () => deferred().promise });

    h.byId.get('openInstall').click();
    expect(h.byId.get('installDialog').open).toBe(false);

    h.byId.get('copyBtn').click();
    expect(h.clipboardCalls).toHaveLength(0);

    h.byId.get('barCopy').click();
    expect(h.clipboardCalls).toHaveLength(0);

    h.byId.get('finishCopy').click();
    expect(h.clipboardCalls).toHaveLength(0);

    h.byId.get('copyCollectionsBtn').click();
    expect(h.clipboardCalls).toHaveLength(0);

    const dlEvt = { type: 'click', target: h.byId.get('downloadCollectionsBtn'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    h.byId.get('downloadCollectionsBtn').dispatchEvent(dlEvt);
    expect(dlEvt.defaultPrevented).toBe(true);
    expect(h.panels['sec-device']._scrolledIntoView || h.panels['sec-device']._heading._focused).toBe(true);
  });

  test('successful device detail load unlocks setup, publishes exact device manifest URL, and enables autosave', async () => {
    const deviceUrl = 'https://sports.example.com/tok_abc/manifest.json';
    const h = createHarness({
      accounts: true,
      search: '?device=dev1',
      fetchImpl: (url) => {
        if (url === '/api/auth/providers') return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true, providers: ['google'] }) });
        if (url === '/api/auth/devices') return Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'dev1', name: 'TV' }] }) });
        if (url === '/api/auth/devices/dev1') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'dev1', manifestUrl: deviceUrl, config: {} }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
    });
    await flushMicrotasks();

    expect(h.context.isDeviceSetupReady()).toBe(true);
    expect(h.window.__deviceUrl).toBe(deviceUrl);
    expect(h.byId.get('manualUrl').value).toBe(deviceUrl);
    expect(h.byId.get('installBtn').getAttribute('href')).toBe('stremio://sports.example.com/tok_abc/manifest.json');
    expect(h.byId.get('installBtn').getAttribute('aria-disabled')).toBeNull();
    expect(h.byId.get('copyBtn').getAttribute('aria-disabled')).toBeNull();
  });

  test('account-disabled self-hosted mode remains ready and publishes generic/encoded URLs immediately', () => {
    const h = createHarness({ accounts: false });

    expect(h.window.__accountsOn).toBe(false);
    expect(h.context.isDeviceSetupReady()).toBe(true);
    expect(h.byId.get('manualUrl').value).toMatch(/^https:\/\/sports\.example\.com\/.*manifest\.json$/);
    expect(h.byId.get('installBtn').getAttribute('href')).toMatch(/^stremio:\/\//);
    expect(h.byId.get('installBtn').getAttribute('aria-disabled')).toBeNull();
  });
});

describe('Configure device prerequisite — Task 2: visible lock UI, inert boundaries, and navigation guards', () => {
  test('downstream sections are marked inert and controls disabled while locked, then unlock without resetting selections', async () => {
    const detailDef = deferred();
    const h = createHarness({
      accounts: true,
      search: '?device=dev1',
      fetchImpl: (url) => {
        if (url === '/api/auth/providers') return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true, providers: ['google'] }) });
        if (url === '/api/auth/devices') return Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'dev1', name: 'TV' }] }) });
        if (url === '/api/auth/devices/dev1') return detailDef.promise;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
    });

    expect(typeof h.context.syncDeviceSetupGate).toBe('function');
    expect(h.byId.get('deviceSelect').disabled).toBe(false);
    expect(h.panels['sec-sports'].hasAttribute('data-device-locked')).toBe(true);
    expect(h.sportsCheckboxes[0].disabled).toBe(true);
    expect(h.byId.get('readyHint').textContent).toContain('Add or choose a device to continue.');

    detailDef.resolve({
      ok: true,
      json: () => Promise.resolve({ id: 'dev1', manifestUrl: 'https://sports.example.com/tok/manifest.json', config: {} })
    });
    await flushMicrotasks();

    expect(h.panels['sec-sports'].hasAttribute('data-device-locked')).toBe(false);
    expect(h.sportsCheckboxes[0].disabled).toBe(false);
    expect(h.sportsCheckboxes[0].checked).toBe(true);
  });

  test('wizard navigation, sidebar shortcuts, and window.nuvioGoTo cannot bypass sec-device while locked', () => {
    const h = createHarness({
      accounts: true,
      mode: 'wizard',
      fetchImpl: () => deferred().promise
    });

    h.window.nuvioGoTo('sec-teams');
    expect(h.panels['sec-device'].classList.contains('is-current')).toBe(true);
    expect(h.panels['sec-teams'].classList.contains('is-current')).toBe(false);

    h.stepNavLinks[2].click();
    expect(h.panels['sec-device'].classList.contains('is-current')).toBe(true);
    expect(h.panels['sec-teams'].classList.contains('is-current')).toBe(false);

    h.supportLinks[0].click();
    expect(h.panels['sec-device'].classList.contains('is-current')).toBe(true);
    expect(h.panels['sec-finish'].classList.contains('is-current')).toBe(false);
  });

  test('single-device redirect and config-restore redirect do not publish generic links before navigation', async () => {
    const h = createHarness({
      accounts: true,
      fetchImpl: (url) => {
        if (url === '/api/auth/providers') return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: true, providers: ['google'] }) });
        if (url === '/api/auth/devices') return Promise.resolve({ ok: true, json: () => Promise.resolve({ devices: [{ id: 'dev1', name: 'Only TV' }] }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
    });
    await flushMicrotasks();

    expect(h.locationCalls.replace).toContain('/configure?device=dev1');
    expect(h.byId.get('manualUrl').value).toBe('');
    expect(h.byId.get('installBtn').getAttribute('href')).toBe('#');
  });
});
