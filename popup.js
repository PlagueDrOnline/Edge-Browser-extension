/**
 * Plague Doctor Controller Mapper — popup UI logic.
 *
 * - reads/writes settings in chrome.storage.sync (lib/shared.js normalises them)
 * - asks the service worker about the Pro license
 * - asks the page bridge (bridge.js) for diagnostics about the current tab
 * - runs a live controller tester right inside the popup
 */
(() => {
  'use strict';

  const {
    STORAGE_KEYS,
    MSG,
    STANDARD_BUTTONS,
    STANDARD_BUTTON_COUNT,
    IDENTITY_MAP,
    normalizeSettings,
    normalizeHost,
    isSwitchId,
    describeGamepadId,
    computeEffectiveConfig,
    buildSwapMap,
    sanitizeBinding,
  } = globalThis.PDCM;

  const ext = globalThis.chrome;

  // ---------------------------------------------------------------------------
  // Branding & monetisation placeholders — edit these.
  // ---------------------------------------------------------------------------
  const BRAND = Object.freeze({
    /**
     * Remote logo (raw GitHub URL). The bundled assets/logo.png is shown until
     * this loads; if it fails (or is still a placeholder) the bundled logo stays.
     * For this repository the final URL will be:
     *   https://raw.githubusercontent.com/PlagueDrOnline/Edge-Browser-extension/main/plague_logo.png
     */
    logoUrl: 'https://raw.githubusercontent.com/[YOUR-GITHUB-USERNAME]/[YOUR-REPO]/main/logo.png',

    /** One-time payment page: Gumroad / Lemon Squeezy / Stripe Payment Link / Ko-fi shop… */
    checkoutUrl: 'https://[YOUR-STORE]/plague-doctor-pro',
    priceLabel: '$2.99 one-time',

    githubUrl: 'https://github.com/[YOUR-GITHUB-USERNAME]/[YOUR-REPO]',
    privacyUrl: 'https://github.com/[YOUR-GITHUB-USERNAME]/[YOUR-REPO]/blob/main/PRIVACY.md',
    supportUrl: 'https://github.com/[YOUR-GITHUB-USERNAME]/[YOUR-REPO]/issues',
  });

  const isPlaceholder = (url) => !url || /[[\]]/.test(url);

  const LICENSE_MESSAGES = Object.freeze({
    ok: 'Pro unlocked — thank you for supporting the Plague Doctor!',
    'not-configured': 'License validation is not configured in this build yet (README → Monetisation).',
    malformed: 'That does not look like a Plague Doctor key. Keys start with “PDCM.”.',
    'bad-signature': 'This key is not valid for Plague Doctor Pro.',
    unsupported: 'This key belongs to a different product or plan.',
    expired: 'This key has expired.',
    revoked: 'This purchase was refunded or disputed, so the key was revoked.',
    network: 'Could not reach the license server. Check your connection and try again.',
    error: 'Validation failed unexpectedly. Please try again.',
    none: '',
  });

  const RESTRICTED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|extension|moz-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    body: document.body,
    brandLogo: $('brandLogo'),
    statusPill: $('statusPill'),
    statusText: $('statusText'),

    toggleEnabled: $('toggleEnabled'),
    toggleSwapAB: $('toggleSwapAB'),
    toggleSwapXY: $('toggleSwapXY'),
    targetRadios: Array.from(document.querySelectorAll('input[name="target"]')),

    siteHost: $('siteHost'),
    pageOk: $('pageOk'),
    pageMissing: $('pageMissing'),
    pageMissingText: $('pageMissingText'),
    btnInject: $('btnInject'),
    toggleSite: $('toggleSite'),
    pageDiag: $('pageDiag'),

    testerPadName: $('testerPadName'),
    faces: Array.from(document.querySelectorAll('.face')),
    testerPhysical: $('testerPhysical'),
    testerMapped: $('testerMapped'),
    testerNote: $('testerNote'),

    proCard: $('proCard'),
    proPrice: $('proPrice'),
    proLocked: $('proLocked'),
    proUnlocked: $('proUnlocked'),
    proEmail: $('proEmail'),
    btnBuy: $('btnBuy'),
    licenseForm: $('licenseForm'),
    licenseKey: $('licenseKey'),
    btnActivate: $('btnActivate'),
    licenseMsg: $('licenseMsg'),
    btnDeactivate: $('btnDeactivate'),
    unlockButtons: Array.from(document.querySelectorAll('[data-unlock]')),

    profileBody: $('profileBody'),
    profileModeRadios: Array.from(document.querySelectorAll('input[name="profileMode"]')),
    profileEditor: $('profileEditor'),
    profileMatrix: $('profileMatrix'),
    btnProfileSwitch: $('btnProfileSwitch'),
    btnProfileIdentity: $('btnProfileIdentity'),
    profileJson: $('profileJson'),
    btnExport: $('btnExport'),
    btnCopy: $('btnCopy'),
    btnImport: $('btnImport'),
    profileMsg: $('profileMsg'),

    keyboardBody: $('keyboardBody'),
    toggleKeyboard: $('toggleKeyboard'),
    kbScopeRadios: Array.from(document.querySelectorAll('input[name="kbScope"]')),
    kbSiteRow: $('kbSiteRow'),
    kbSiteHost: $('kbSiteHost'),
    toggleKbSite: $('toggleKbSite'),
    toggleDpadArrows: $('toggleDpadArrows'),
    leftStickRadios: Array.from(document.querySelectorAll('input[name="leftStick"]')),
    deadzone: $('deadzone'),
    deadzoneValue: $('deadzoneValue'),
    bindings: $('bindings'),
    btnAddBinding: $('btnAddBinding'),

    versionLabel: $('versionLabel'),
    linkGithub: $('linkGithub'),
    linkPrivacy: $('linkPrivacy'),
    linkSupport: $('linkSupport'),
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let settings = normalizeSettings(null);
  let licenseStatus = null; // cached object from background
  let pageStatus = null; // reply from bridge.js, null when unavailable
  let pageProbe = { done: false, restricted: false, error: '' };
  let activeTab = null;
  let saveTimer = 0;
  let draftBinding = null; // { button } — shown until a key is captured
  let capture = null; // { kind: 'draft' | 'binding', index, button }
  let statusTimer = 0;
  let matrixSelects = [];

  const isPro = () => !!(licenseStatus && licenseStatus.valid);
  const siteHost = () => (pageStatus && pageStatus.siteHost) || '';

  /** Effective config for the current site, memoised (the tester asks ~60×/s). */
  const effMemo = { settings: null, license: null, host: null, value: null };
  function effectiveConfig() {
    const host = siteHost();
    if (effMemo.settings !== settings || effMemo.license !== licenseStatus || effMemo.host !== host) {
      effMemo.settings = settings;
      effMemo.license = licenseStatus;
      effMemo.host = host;
      effMemo.value = computeEffectiveConfig(settings, licenseStatus, host);
    }
    return effMemo.value;
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  async function loadSettings() {
    const stored = await ext.storage.sync.get(STORAGE_KEYS.settings);
    settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  }

  let lastSaved = ''; // JSON of the last value we wrote, to recognise our own storage events

  function writeSettings() {
    lastSaved = JSON.stringify(settings);
    return ext.storage.sync.set({ [STORAGE_KEYS.settings]: settings }).catch(() => { /* quota / transient */ });
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      writeSettings();
    }, 120);
  }

  /** Apply a mutation, normalise, save, re-render. */
  function update(mutate) {
    const draft = JSON.parse(JSON.stringify(settings));
    mutate(draft);
    settings = normalizeSettings(draft);
    // Reflect the change immediately instead of waiting for the next bridge poll.
    if (pageStatus) pageStatus.effective = computeEffectiveConfig(settings, licenseStatus, pageStatus.siteHost);
    persist();
    render();
  }

  // ---------------------------------------------------------------------------
  // Background / bridge messaging
  // ---------------------------------------------------------------------------
  async function callBackground(type, payload = {}) {
    const res = await ext.runtime.sendMessage({ type, ...payload });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No response from service worker');
    return res.result;
  }

  async function refreshLicense(force = false) {
    try {
      licenseStatus = await callBackground(MSG.LICENSE_STATUS, { force });
    } catch (_) {
      const local = await ext.storage.local.get(STORAGE_KEYS.licenseStatus);
      licenseStatus = local[STORAGE_KEYS.licenseStatus] || null;
    }
  }

  async function queryPageStatus() {
    try {
      if (!activeTab) {
        const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
        activeTab = tab || null;
      }
      if (!activeTab || !Number.isInteger(activeTab.id)) throw new Error('no-tab');
      if (activeTab.url && RESTRICTED_URL.test(activeTab.url)) {
        pageStatus = null;
        pageProbe = { done: true, restricted: true, error: '' };
        return;
      }
      const reply = await ext.tabs.sendMessage(activeTab.id, { type: MSG.PAGE_STATUS }, { frameId: 0 });
      pageStatus = reply && reply.ok ? reply : null;
      pageProbe = { done: true, restricted: false, error: pageStatus ? '' : 'no-reply' };
    } catch (err) {
      pageStatus = null;
      pageProbe = { done: true, restricted: false, error: (err && err.message) || 'unavailable' };
    }
  }

  async function injectIntoActiveTab() {
    if (!activeTab) return;
    els.btnInject.disabled = true;
    els.btnInject.textContent = 'Activating…';
    try {
      await callBackground(MSG.INJECT_TAB, { tabId: activeTab.id });
      await new Promise((r) => setTimeout(r, 350));
      await queryPageStatus();
    } catch (err) {
      pageProbe.error = (err && err.message) || 'inject-failed';
    } finally {
      els.btnInject.disabled = false;
      els.btnInject.textContent = 'Activate on this tab';
      renderPage();
      renderStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render() {
    renderMaster();
    renderPage();
    renderPro();
    renderProfile();
    renderKeyboard();
    renderStatus();
  }

  function setRadio(radios, value) {
    for (const r of radios) r.checked = r.value === value;
  }

  function renderMaster() {
    els.toggleEnabled.checked = settings.enabled;
    els.toggleSwapAB.checked = settings.swapAB;
    els.toggleSwapXY.checked = settings.swapXY;
    setRadio(els.targetRadios, settings.target);
  }

  function renderStatus() {
    let state = 'on';
    let text = 'Active';
    if (!settings.enabled) {
      state = 'off';
      text = 'Off';
    } else if (pageStatus && pageStatus.effective && !pageStatus.effective.siteEnabled) {
      state = 'paused';
      text = 'Paused here';
    } else if (pageProbe.done && !pageStatus) {
      state = 'paused';
      text = pageProbe.restricted ? 'N/A here' : 'Not in tab';
    } else if (!pageProbe.done) {
      state = 'loading';
      text = 'Checking…';
    }
    els.statusPill.dataset.state = state;
    els.statusText.textContent = text;
  }

  function diagItem(text, tone) {
    const li = document.createElement('li');
    li.textContent = text;
    if (tone) li.dataset.tone = tone;
    return li;
  }

  function formatAgo(ms) {
    if (ms == null) return '';
    if (ms < 1000) return 'just now';
    if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
    return `${Math.round(ms / 60000)} min ago`;
  }

  function renderPage() {
    const host = siteHost();
    els.siteHost.textContent = host || (activeTab && activeTab.url ? safeHost(activeTab.url) : '—');
    els.siteHost.title = (pageStatus && pageStatus.url) || (activeTab && activeTab.url) || '';

    if (!pageStatus) {
      els.pageOk.hidden = true;
      els.pageMissing.hidden = false;
      if (pageProbe.restricted) {
        els.pageMissingText.textContent = 'Browser pages and extension stores cannot be scripted. Open a game tab to use the remap.';
        els.btnInject.hidden = true;
      } else if (!pageProbe.done) {
        els.pageMissingText.textContent = 'Checking this tab…';
        els.btnInject.hidden = true;
      } else {
        els.pageMissingText.textContent = 'The hook is not running in this tab yet — usually because the tab was opened before the extension was installed. Reload the page or activate it now.';
        els.btnInject.hidden = false;
      }
      return;
    }

    els.pageOk.hidden = false;
    els.pageMissing.hidden = true;

    els.toggleSite.checked = !settings.disabledSites.includes(host);
    els.toggleSite.disabled = !host;

    const eff = pageStatus.effective || effectiveConfig();
    const page = pageStatus.page;
    const list = document.createDocumentFragment();

    if (pageStatus.hookReady) {
      list.appendChild(diagItem(`Page hook installed${pageStatus.hookVersion ? ` (v${pageStatus.hookVersion})` : ''}`, 'ok'));
    } else {
      list.appendChild(diagItem('Page hook did not answer — reload the tab', 'warn'));
    }

    if (page) {
      if (page.calls > 0) {
        list.appendChild(diagItem(`Page polls the Gamepad API (${page.calls}×, ${formatAgo(page.lastCallAgoMs)})`, 'ok'));
      } else {
        list.appendChild(diagItem('Page has not requested gamepad input yet', null));
      }
      if (page.remapped && page.remapped.length) {
        const names = page.remapped.map((p) => describeGamepadId(p.id).name).join(', ');
        list.appendChild(diagItem(`Remapping: ${names}`, 'ok'));
      } else if (eff.enabled) {
        list.appendChild(diagItem(eff.target === 'all' ? 'Waiting for a controller' : 'Waiting for a Switch controller', null));
      } else if (!eff.siteEnabled) {
        list.appendChild(diagItem('Remap paused on this site', 'warn'));
      } else if (!settings.enabled) {
        list.appendChild(diagItem('Plague Remap is switched off', 'warn'));
      }
      if (eff.keyboard && eff.keyboard.enabled) {
        list.appendChild(diagItem(page.keyboardActive ? 'Keyboard translation running' : 'Keyboard translation armed', 'ok'));
      } else if (isPro() && settings.keyboard.enabled && !eff.keyboardSiteAllowed) {
        list.appendChild(diagItem('Keyboard translation: site not allowed', 'warn'));
      }
    }

    els.pageDiag.replaceChildren(list);
  }

  function safeHost(url) {
    try { return normalizeHost(new URL(url).hostname) || url; } catch (_) { return url; }
  }

  function renderPro() {
    const pro = isPro();
    els.body.dataset.pro = pro ? 'true' : 'false';
    els.proLocked.hidden = pro;
    els.proUnlocked.hidden = !pro;
    els.proPrice.textContent = BRAND.priceLabel;

    if (pro) {
      const who = licenseStatus.email ? `· ${licenseStatus.email}` : '';
      const exp = licenseStatus.expiresAt ? ` · until ${new Date(licenseStatus.expiresAt * 1000).toLocaleDateString()}` : '';
      els.proEmail.textContent = `${who}${exp}`;
    }

    if (isPlaceholder(BRAND.checkoutUrl)) {
      els.btnBuy.removeAttribute('href');
      els.btnBuy.setAttribute('aria-disabled', 'true');
      els.btnBuy.title = 'Set BRAND.checkoutUrl in popup.js';
    } else {
      els.btnBuy.href = BRAND.checkoutUrl;
    }

    els.profileBody.disabled = !pro;
    els.keyboardBody.disabled = !pro;
    els.toggleKeyboard.disabled = !pro;
  }

  // ---- profile / button matrix ---------------------------------------------
  function physicalLabel(i) {
    const b = STANDARD_BUTTONS[i];
    return `${i} · ${b.position} — Xbox ${b.xbox} / Switch ${b.nintendo}`;
  }

  function buildMatrix() {
    const frag = document.createDocumentFragment();
    matrixSelects = [];
    for (const out of STANDARD_BUTTONS) {
      const label = document.createElement('div');
      label.className = 'out';
      const kbd = document.createElement('kbd');
      kbd.textContent = out.name;
      const desc = document.createElement('span');
      desc.className = 'muted small';
      desc.textContent = `#${out.index} · ${out.position.toLowerCase()}`;
      label.append(kbd, desc);

      const select = document.createElement('select');
      select.setAttribute('aria-label', `Physical button feeding ${out.name}`);
      for (let i = 0; i < STANDARD_BUTTON_COUNT; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = physicalLabel(i);
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        const value = Number(select.value);
        update((s) => {
          s.profile.map[out.index] = value;
          s.profile.mode = 'custom';
        });
      });
      matrixSelects.push(select);
      frag.append(label, select);
    }
    els.profileMatrix.replaceChildren(frag);
  }

  function renderProfile() {
    setRadio(els.profileModeRadios, settings.profile.mode);
    matrixSelects.forEach((select, i) => { select.value = String(settings.profile.map[i]); });
  }

  function exportProfile() {
    const payload = {
      pdcmProfile: 1,
      name: settings.profile.name,
      map: settings.profile.map,
      target: settings.target,
      keyboard: {
        dpadArrows: settings.keyboard.dpadArrows,
        leftStick: settings.keyboard.leftStick,
        deadzone: settings.keyboard.deadzone,
        bindings: settings.keyboard.bindings,
      },
    };
    els.profileJson.value = JSON.stringify(payload, null, 2);
    setMsg(els.profileMsg, 'Profile exported below — copy it or save it to a file.', 'ok');
  }

  function importProfile() {
    let data;
    try {
      data = JSON.parse(els.profileJson.value);
    } catch (_) {
      setMsg(els.profileMsg, 'That is not valid JSON.', 'error');
      return;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.map)) {
      setMsg(els.profileMsg, 'Profile must contain a "map" array with 17 button indexes.', 'error');
      return;
    }
    update((s) => {
      s.profile.mode = 'custom';
      s.profile.map = data.map;
      if (typeof data.name === 'string') s.profile.name = data.name;
      if (data.target === 'all' || data.target === 'switch') s.target = data.target;
      if (data.keyboard && typeof data.keyboard === 'object') {
        const kb = data.keyboard;
        if (typeof kb.dpadArrows === 'boolean') s.keyboard.dpadArrows = kb.dpadArrows;
        if (typeof kb.leftStick === 'string') s.keyboard.leftStick = kb.leftStick;
        if (Number.isFinite(kb.deadzone)) s.keyboard.deadzone = kb.deadzone;
        if (Array.isArray(kb.bindings)) s.keyboard.bindings = kb.bindings.map(sanitizeBinding).filter(Boolean);
      }
    });
    setMsg(els.profileMsg, `Imported “${settings.profile.name}”. Custom profile is now active.`, 'ok');
  }

  async function copyProfile() {
    if (!els.profileJson.value) exportProfile();
    try {
      await navigator.clipboard.writeText(els.profileJson.value);
      setMsg(els.profileMsg, 'Copied to clipboard.', 'ok');
    } catch (_) {
      els.profileJson.select();
      setMsg(els.profileMsg, 'Press Ctrl/Cmd+C to copy.', null);
    }
  }

  function setMsg(el, text, tone) {
    el.textContent = text || '';
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  }

  // ---- keyboard translation --------------------------------------------------
  function outputOption(i) {
    const b = STANDARD_BUTTONS[i];
    return `${b.name} (${i})`;
  }

  /** Only the parts that depend on the current tab (safe to call from the poll timer). */
  function renderKeyboardSite() {
    const kb = settings.keyboard;
    const host = siteHost();
    els.kbSiteRow.hidden = kb.scope === 'all';
    els.kbSiteHost.textContent = host || 'this site';
    els.toggleKbSite.checked = !!host && kb.sites.includes(host);
    els.toggleKbSite.disabled = !host || !isPro();
  }

  function renderKeyboard() {
    const kb = settings.keyboard;
    els.toggleKeyboard.checked = kb.enabled;
    setRadio(els.kbScopeRadios, kb.scope);
    renderKeyboardSite();
    els.toggleDpadArrows.checked = kb.dpadArrows;
    setRadio(els.leftStickRadios, kb.leftStick);
    els.deadzone.value = String(kb.deadzone);
    els.deadzoneValue.textContent = kb.deadzone.toFixed(2);
    renderBindings();
  }

  function renderBindings() {
    const frag = document.createDocumentFragment();
    const rows = settings.keyboard.bindings.map((b, index) => ({ kind: 'binding', index, binding: b }));
    if (draftBinding) rows.push({ kind: 'draft', index: -1, binding: draftBinding });

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'bindings-empty';
      empty.textContent = 'No key bindings yet. Example: A → Space, B → Escape, Start → Enter.';
      frag.appendChild(empty);
    }

    for (const row of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'binding';

      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Controller button');
      for (let i = 0; i < STANDARD_BUTTON_COUNT; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = outputOption(i);
        select.appendChild(opt);
      }
      select.value = String(row.binding.button);
      select.addEventListener('change', () => {
        const button = Number(select.value);
        if (row.kind === 'draft') { draftBinding.button = button; return; }
        update((s) => { s.keyboard.bindings[row.index].button = button; });
      });

      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'key-capture';
      const listening = capture && capture.kind === row.kind && capture.index === row.index;
      keyBtn.textContent = listening ? 'Press a key…' : (row.binding.code || 'Set key');
      keyBtn.classList.toggle('listening', !!listening);
      keyBtn.title = row.binding.key ? `key: ${row.binding.key} · code: ${row.binding.code} · keyCode: ${row.binding.keyCode}` : 'Click, then press the key to send';
      keyBtn.addEventListener('click', () => {
        if (listening) { stopCapture(); return; }
        startCapture(row.kind, row.index);
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.setAttribute('aria-label', 'Remove binding');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (row.kind === 'draft') { draftBinding = null; stopCapture(); return; }
        update((s) => { s.keyboard.bindings.splice(row.index, 1); });
      });

      wrap.append(select, keyBtn, remove);
      frag.appendChild(wrap);
    }
    els.bindings.replaceChildren(frag);
  }

  function startCapture(kind, index) {
    capture = { kind, index };
    renderBindings();
  }

  function stopCapture() {
    capture = null;
    renderBindings();
  }

  function onCaptureKeydown(event) {
    if (!capture) return;
    event.preventDefault();
    event.stopPropagation();
    const captured = { key: event.key, code: event.code || event.key, keyCode: event.keyCode || event.which || 0 };
    if (capture.kind === 'draft' && draftBinding) {
      const button = draftBinding.button;
      draftBinding = null;
      capture = null;
      update((s) => { s.keyboard.bindings.push({ button, ...captured }); });
    } else if (capture.kind === 'binding') {
      const idx = capture.index;
      capture = null;
      update((s) => { Object.assign(s.keyboard.bindings[idx], captured); });
    } else {
      stopCapture();
    }
  }

  // ---------------------------------------------------------------------------
  // Live tester — polls the Gamepad API right here in the popup
  // ---------------------------------------------------------------------------
  const tester = { lastSignature: '', hadPad: false };

  function pressed(button) {
    return !!button && (button.pressed || button.value > 0.5);
  }

  function testerTick() {
    requestAnimationFrame(testerTick);
    let pads = [];
    try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (_) { pads = []; }
    let pad = null;
    for (const p of pads) { if (p && p.connected) { pad = p; break; } }

    if (!pad) {
      if (tester.hadPad || !tester.lastSignature) {
        tester.hadPad = false;
        tester.lastSignature = 'none';
        els.testerPadName.textContent = 'Press any button on your controller';
        els.testerPhysical.textContent = '—';
        els.testerMapped.textContent = '—';
        els.testerNote.textContent = '';
        for (const f of els.faces) f.classList.remove('pressed', 'pressed-raw');
      }
      return;
    }

    const eff = effectiveConfig();
    const switchPad = isSwitchId(pad.id);
    const applies = eff.enabled && (eff.target === 'all' || switchPad);
    const map = applies ? eff.map : IDENTITY_MAP;

    const physical = [];
    const mapped = [];
    const count = Math.min(pad.buttons.length, STANDARD_BUTTON_COUNT);
    for (let i = 0; i < count; i++) if (pressed(pad.buttons[i])) physical.push(i);
    for (let out = 0; out < count; out++) if (pressed(pad.buttons[map[out]])) mapped.push(out);

    const signature = `${pad.id}|${applies}|${physical.join(',')}|${mapped.join(',')}`;
    if (signature === tester.lastSignature) return;
    tester.lastSignature = signature;
    tester.hadPad = true;

    const info = describeGamepadId(pad.id);
    els.testerPadName.textContent = `${info.name}${info.vendor ? ` · ${info.vendor}:${info.product}` : ''} · ${switchPad ? 'Switch' : 'other'}`;
    els.testerPhysical.textContent = physical.length
      ? physical.map((i) => `${switchPad ? STANDARD_BUTTONS[i].nintendo : STANDARD_BUTTONS[i].xbox} (${i})`).join(' ')
      : '—';
    els.testerMapped.textContent = mapped.length ? mapped.map((o) => `${STANDARD_BUTTONS[o].name} (${o})`).join(' ') : '—';
    els.testerNote.textContent = applies
      ? `Remap active — “Game sees” is what ${eff.host || 'this page'} receives.`
      : !settings.enabled
        ? 'Plague Remap is off — buttons pass through unchanged.'
        : !eff.siteEnabled
          ? 'Remap paused on this site — buttons pass through unchanged.'
          : switchPad
            ? 'Swaps disabled — buttons pass through unchanged.'
            : 'Not a Switch pad — passthrough. Choose “All controllers” to remap it.';

    for (const face of els.faces) {
      const out = Number(face.dataset.out);
      face.classList.toggle('pressed', mapped.includes(out));
      face.classList.toggle('pressed-raw', physical.includes(out));
    }
  }

  // ---------------------------------------------------------------------------
  // Branding
  // ---------------------------------------------------------------------------
  function applyBranding() {
    els.versionLabel.textContent = `v${ext.runtime.getManifest().version}`;

    const links = [
      [els.linkGithub, BRAND.githubUrl],
      [els.linkPrivacy, BRAND.privacyUrl],
      [els.linkSupport, BRAND.supportUrl],
    ];
    for (const [el, url] of links) {
      if (isPlaceholder(url)) el.hidden = true; else el.href = url;
    }

    if (!isPlaceholder(BRAND.logoUrl)) {
      const probe = new Image();
      probe.decoding = 'async';
      probe.addEventListener('load', () => {
        els.brandLogo.src = BRAND.logoUrl;
        document.documentElement.style.setProperty('--brand-logo-url', `url("${BRAND.logoUrl}")`);
      });
      probe.src = BRAND.logoUrl; // silently keeps the bundled logo on error
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function bindEvents() {
    els.toggleEnabled.addEventListener('change', () => update((s) => { s.enabled = els.toggleEnabled.checked; }));
    els.toggleSwapAB.addEventListener('change', () => update((s) => { s.swapAB = els.toggleSwapAB.checked; }));
    els.toggleSwapXY.addEventListener('change', () => update((s) => { s.swapXY = els.toggleSwapXY.checked; }));
    for (const r of els.targetRadios) {
      r.addEventListener('change', () => { if (r.checked) update((s) => { s.target = r.value; }); });
    }

    els.toggleSite.addEventListener('change', () => {
      const host = siteHost();
      if (!host) return;
      update((s) => {
        s.disabledSites = s.disabledSites.filter((h) => h !== host);
        if (!els.toggleSite.checked) s.disabledSites.push(host);
      });
    });
    els.btnInject.addEventListener('click', injectIntoActiveTab);

    // Pro / license
    els.licenseForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const key = els.licenseKey.value.trim();
      if (!key) { setMsg(els.licenseMsg, 'Paste your license key first.', 'error'); return; }
      els.btnActivate.disabled = true;
      setMsg(els.licenseMsg, 'Checking key…', null);
      try {
        const result = await callBackground(MSG.LICENSE_ACTIVATE, { key });
        if (result && result.valid) {
          licenseStatus = result;
          els.licenseKey.value = '';
          setMsg(els.licenseMsg, LICENSE_MESSAGES.ok, 'ok');
        } else {
          setMsg(els.licenseMsg, LICENSE_MESSAGES[(result && result.reason) || 'error'] || LICENSE_MESSAGES.error, 'error');
        }
      } catch (err) {
        setMsg(els.licenseMsg, `${LICENSE_MESSAGES.error} (${err.message})`, 'error');
      } finally {
        els.btnActivate.disabled = false;
        render();
      }
    });

    els.btnDeactivate.addEventListener('click', async () => {
      try {
        licenseStatus = await callBackground(MSG.LICENSE_DEACTIVATE);
      } catch (_) { /* ignore */ }
      setMsg(els.licenseMsg, 'Pro deactivated. Your key can be re-activated at any time.', null);
      render();
    });

    for (const btn of els.unlockButtons) {
      btn.addEventListener('click', () => {
        els.proCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        els.licenseKey.focus({ preventScroll: true });
      });
    }

    // Profile
    for (const r of els.profileModeRadios) {
      r.addEventListener('change', () => {
        if (!r.checked) return;
        update((s) => { s.profile.mode = r.value; });
        if (r.value === 'custom') els.profileEditor.open = true;
      });
    }
    els.btnProfileSwitch.addEventListener('click', () => update((s) => { s.profile.map = buildSwapMap(true, true); s.profile.mode = 'custom'; }));
    els.btnProfileIdentity.addEventListener('click', () => update((s) => { s.profile.map = IDENTITY_MAP.slice(); s.profile.mode = 'custom'; }));
    els.btnExport.addEventListener('click', exportProfile);
    els.btnCopy.addEventListener('click', copyProfile);
    els.btnImport.addEventListener('click', importProfile);

    // Keyboard translation
    els.toggleKeyboard.addEventListener('change', () => update((s) => { s.keyboard.enabled = els.toggleKeyboard.checked; }));
    for (const r of els.kbScopeRadios) {
      r.addEventListener('change', () => { if (r.checked) update((s) => { s.keyboard.scope = r.value; }); });
    }
    els.toggleKbSite.addEventListener('change', () => {
      const host = siteHost();
      if (!host) return;
      update((s) => {
        s.keyboard.sites = s.keyboard.sites.filter((h) => h !== host);
        if (els.toggleKbSite.checked) s.keyboard.sites.push(host);
      });
    });
    els.toggleDpadArrows.addEventListener('change', () => update((s) => { s.keyboard.dpadArrows = els.toggleDpadArrows.checked; }));
    for (const r of els.leftStickRadios) {
      r.addEventListener('change', () => { if (r.checked) update((s) => { s.keyboard.leftStick = r.value; }); });
    }
    els.deadzone.addEventListener('input', () => {
      els.deadzoneValue.textContent = Number(els.deadzone.value).toFixed(2);
    });
    els.deadzone.addEventListener('change', () => update((s) => { s.keyboard.deadzone = Number(els.deadzone.value); }));
    els.btnAddBinding.addEventListener('click', () => {
      draftBinding = { button: 0 };
      startCapture('draft', -1);
    });

    // Key capture (capture phase so nothing else in the popup reacts)
    document.addEventListener('keydown', onCaptureKeydown, true);
    document.addEventListener('pointerdown', (event) => {
      if (capture && !(event.target instanceof Element && event.target.closest('.key-capture'))) stopCapture();
    }, true);

    // Follow changes made elsewhere (another popup instance / synced device)
    ext.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'sync' && changes[STORAGE_KEYS.settings]) {
        const incoming = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
        const json = JSON.stringify(incoming);
        // Ignore echoes of our own writes (and anything we already show) so a
        // toggle made while a save is in flight is never rolled back.
        if (json === lastSaved || json === JSON.stringify(settings)) return;
        settings = incoming;
        render();
      }
      if (area === 'local' && changes[STORAGE_KEYS.licenseStatus]) {
        licenseStatus = changes[STORAGE_KEYS.licenseStatus].newValue || null;
        render();
      }
    });

    // Flush a pending debounced save when the popup closes.
    window.addEventListener('pagehide', () => {
      clearInterval(statusTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = 0;
        writeSettings();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function init() {
    applyBranding();
    buildMatrix();
    bindEvents();
    await Promise.all([loadSettings(), refreshLicense()]);
    render();
    await queryPageStatus();
    render();
    statusTimer = setInterval(async () => {
      await queryPageStatus();
      renderPage();
      renderStatus();
      renderKeyboardSite();
    }, 1500);
    requestAnimationFrame(testerTick);
  }

  init().catch((err) => {
    els.statusPill.dataset.state = 'off';
    els.statusText.textContent = 'Error';
    console.error('[Plague Doctor Controller Mapper] popup failed to start:', err);
  });
})();
