/**
 * Loads popup.html + popup.js in jsdom with a fake chrome.* API and walks
 * through the main UI flows. Skipped automatically when jsdom is not installed
 * (`npm install` adds it as a devDependency).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDCM = require('../lib/shared.js');

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional */ }

const SWITCH_ID = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeChrome(scenario) {
  const sync = new Map();
  const local = new Map();
  const changeListeners = [];
  const area = (data, name) => ({
    async get(key) { const out = {}; if (data.has(key)) out[key] = structuredClone(data.get(key)); return out; },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data.get(k), newValue: structuredClone(v) }; data.set(k, structuredClone(v)); }
      changeListeners.forEach((fn) => fn(changes, name));
    },
    async remove(key) { data.delete(key); },
  });
  const messages = [];
  return {
    sync, local, messages,
    chrome: {
      storage: { sync: area(sync, 'sync'), local: area(local, 'local'), onChanged: { addListener: (fn) => changeListeners.push(fn) } },
      runtime: {
        id: 'ext',
        getManifest: () => ({ version: '1.0.0' }),
        async sendMessage(msg) {
          messages.push(msg);
          if (msg.type === PDCM.MSG.LICENSE_STATUS) return { ok: true, result: scenario.license };
          if (msg.type === PDCM.MSG.LICENSE_ACTIVATE) {
            const valid = msg.key.startsWith('PDCM.good');
            scenario.license = valid
              ? { valid: true, reason: 'ok', email: 'buyer@example.com', expiresAt: null }
              : { valid: false, reason: 'bad-signature' };
            return { ok: true, result: scenario.license };
          }
          if (msg.type === PDCM.MSG.LICENSE_DEACTIVATE) { scenario.license = { valid: false, reason: 'none' }; return { ok: true, result: scenario.license }; }
          if (msg.type === PDCM.MSG.INJECT_TAB) { scenario.bridge = true; return { ok: true, result: { ok: true } }; }
          return { ok: false, error: 'unknown' };
        },
      },
      tabs: {
        async query() { return [{ id: 1, url: scenario.url }]; },
        async sendMessage() {
          if (!scenario.bridge) throw new Error('Could not establish connection. Receiving end does not exist.');
          const effective = PDCM.computeEffectiveConfig(sync.get(PDCM.STORAGE_KEYS.settings), scenario.license, 'itch.io');
          return {
            ok: true, host: 'itch.io', siteHost: 'itch.io', url: scenario.url, hookReady: true, hookVersion: '1.0.0', effective,
            page: { version: '1.0.0', remapActive: effective.enabled, keyboardActive: false, calls: 12, lastCallAgoMs: 300, remapped: [{ index: 0, id: SWITCH_ID }] },
          };
        },
      },
    },
  };
}

async function openPopup(scenario = {}) {
  const sc = { url: 'https://itch.io/some-game', bridge: true, license: { valid: false, reason: 'none' }, pads: [], ...scenario };
  const fake = fakeChrome(sc);
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.chrome = fake.chrome;
      window.Element.prototype.scrollIntoView = () => {};
      Object.defineProperty(window.navigator, 'getGamepads', { value: () => sc.pads, configurable: true });
    },
  });
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);
  // wait for popup.js to finish booting (status pill leaves the loading state)
  for (let i = 0; i < 100 && /Loading|Checking/.test($('statusText').textContent); i++) await sleep(20);
  await sleep(50);
  return { window, document: window.document, $, fake, scenario: sc, dom };
}

function makePad(pressedIndexes = []) {
  return {
    id: SWITCH_ID, index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressedIndexes.includes(i), touched: false, value: pressedIndexes.includes(i) ? 1 : 0 })),
  };
}

test('popup boots, shows page diagnostics and the free tier controls', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup();
  assert.equal(p.$('statusPill').dataset.state, 'on');
  assert.equal(p.$('statusText').textContent, 'Active');
  assert.equal(p.$('siteHost').textContent, 'itch.io');
  assert.equal(p.$('pageOk').hidden, false);
  const diag = Array.from(p.document.querySelectorAll('#pageDiag li')).map((li) => li.textContent);
  assert.ok(diag.some((t) => t.startsWith('Page hook installed')), diag.join(' | '));
  assert.ok(diag.some((t) => t.includes('Remapping: Pro Controller')), diag.join(' | '));
  assert.equal(p.$('toggleEnabled').checked, true);
  assert.equal(p.$('toggleSwapAB').checked, true);
  assert.equal(p.document.body.dataset.pro, 'false');
  assert.equal(p.$('profileBody').disabled, true);
  assert.equal(p.$('keyboardBody').disabled, true);
  assert.equal(p.$('versionLabel').textContent, 'v1.0.0');
  assert.equal(p.document.querySelectorAll('#profileMatrix select').length, 17);
  p.window.close();
});

test('master toggle persists to storage and updates the status pill', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup();
  p.$('toggleEnabled').click();
  await sleep(250); // debounced save
  const saved = p.fake.sync.get(PDCM.STORAGE_KEYS.settings);
  assert.equal(saved.enabled, false);
  assert.equal(p.$('statusPill').dataset.state, 'off');

  p.$('toggleSite').click();
  await sleep(250);
  assert.deepEqual(p.fake.sync.get(PDCM.STORAGE_KEYS.settings).disabledSites, ['itch.io']);
  p.window.close();
});

test('missing bridge shows the "Activate on this tab" path', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup({ bridge: false });
  assert.equal(p.$('pageMissing').hidden, false);
  assert.equal(p.$('btnInject').hidden, false);
  assert.equal(p.$('statusText').textContent, 'Not in tab');
  p.$('btnInject').click();
  await sleep(600);
  assert.ok(p.fake.messages.some((m) => m.type === PDCM.MSG.INJECT_TAB && m.tabId === 1));
  assert.equal(p.$('pageOk').hidden, false, 'diagnostics visible after injection');
  p.window.close();
});

test('restricted browser pages are explained instead of failing', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup({ url: 'edge://extensions/' });
  assert.equal(p.$('btnInject').hidden, true);
  assert.match(p.$('pageMissingText').textContent, /cannot be scripted/);
  p.window.close();
});

test('live tester shows physical vs game-facing buttons', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup({ pads: [makePad([1])] }); // physical Switch "A" (standard index 1)
  await sleep(120);
  assert.match(p.$('testerPadName').textContent, /Pro Controller · 057e:2009 · Switch/);
  assert.equal(p.$('testerPhysical').textContent, 'A (1)');
  assert.equal(p.$('testerMapped').textContent, 'A (0)');
  assert.ok(p.document.querySelector('.face-a').classList.contains('pressed'));
  assert.ok(!p.document.querySelector('.face-b').classList.contains('pressed'));
  p.window.close();
});

test('license activation unlocks Pro features; bad keys are explained', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup();
  p.$('licenseKey').value = 'PDCM.bad.key';
  p.$('licenseForm').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(80);
  assert.equal(p.$('licenseMsg').dataset.tone, 'error');
  assert.match(p.$('licenseMsg').textContent, /not valid/);
  assert.equal(p.document.body.dataset.pro, 'false');

  p.$('licenseKey').value = 'PDCM.good.key';
  p.$('licenseForm').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(80);
  assert.equal(p.$('licenseMsg').dataset.tone, 'ok');
  assert.equal(p.document.body.dataset.pro, 'true');
  assert.equal(p.$('proUnlocked').hidden, false);
  assert.match(p.$('proEmail').textContent, /buyer@example.com/);
  assert.equal(p.$('profileBody').disabled, false);
  assert.equal(p.$('keyboardBody').disabled, false);
  assert.equal(p.$('toggleKeyboard').disabled, false);

  p.$('btnDeactivate').click();
  await sleep(80);
  assert.equal(p.document.body.dataset.pro, 'false');
  p.window.close();
});

test('Pro: key binding capture and profile import/export', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup({ license: { valid: true, reason: 'ok', email: 'buyer@example.com' } });
  assert.equal(p.document.body.dataset.pro, 'true');

  // keyboard translation on + allow this site
  p.$('toggleKeyboard').click();
  p.$('toggleKbSite').click();
  await sleep(250);
  let saved = p.fake.sync.get(PDCM.STORAGE_KEYS.settings);
  assert.equal(saved.keyboard.enabled, true);
  assert.deepEqual(saved.keyboard.sites, ['itch.io']);

  // add a binding: pick "Start (9)" then press Enter
  p.$('btnAddBinding').click();
  const row = p.document.querySelector('.binding');
  assert.ok(row, 'draft row rendered');
  assert.equal(row.querySelector('.key-capture').textContent, 'Press a key…');
  const select = row.querySelector('select');
  select.value = '9';
  select.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
  await sleep(250);
  saved = p.fake.sync.get(PDCM.STORAGE_KEYS.settings);
  assert.deepEqual(saved.keyboard.bindings, [{ button: 9, key: 'Enter', code: 'Enter', keyCode: 13 }]);
  assert.equal(p.document.querySelector('.binding .key-capture').textContent, 'Enter');

  // export → JSON contains the map; import a custom map
  p.$('btnExport').click();
  const exported = JSON.parse(p.$('profileJson').value);
  assert.equal(exported.pdcmProfile, 1);
  assert.equal(exported.map.length, 17);

  p.$('profileJson').value = JSON.stringify({ pdcmProfile: 1, name: 'Fighting game', map: [3, 2, 1, 0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] });
  p.$('btnImport').click();
  await sleep(250);
  saved = p.fake.sync.get(PDCM.STORAGE_KEYS.settings);
  assert.equal(saved.profile.mode, 'custom');
  assert.equal(saved.profile.name, 'Fighting game');
  assert.deepEqual(saved.profile.map.slice(0, 4), [3, 2, 1, 0]);
  assert.equal(p.document.querySelectorAll('#profileMatrix select')[0].value, '3');
  assert.match(p.$('profileMsg').textContent, /Imported “Fighting game”/);

  p.$('profileJson').value = '{not json';
  p.$('btnImport').click();
  assert.equal(p.$('profileMsg').dataset.tone, 'error');
  p.window.close();
});

test('rapid toggles are not rolled back by the echo of an earlier save', { skip: !JSDOM && 'jsdom not installed' }, async () => {
  const p = await openPopup();
  p.$('toggleSwapAB').click();      // save #1 scheduled
  await sleep(150);                 // save #1 written → storage.onChanged echo arrives
  p.$('toggleSwapXY').click();      // save #2 scheduled while echo #1 is being processed
  await sleep(300);
  const saved = p.fake.sync.get(PDCM.STORAGE_KEYS.settings);
  assert.equal(saved.swapAB, false);
  assert.equal(saved.swapXY, false);
  assert.equal(p.$('toggleSwapXY').checked, false);
  p.window.close();
});
