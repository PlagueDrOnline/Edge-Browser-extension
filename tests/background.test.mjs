/**
 * Runs background.js (the MV3 service worker) in a vm context with a fake
 * chrome.* API and exercises the license + injection message handlers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const License = require('../lib/license.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pair = await License.generateKeyPair();
const publicJwk = { kty: 'EC', crv: 'P-256', x: pair.publicJwk.x, y: pair.publicJwk.y };

function fakeChrome() {
  const areas = {};
  const changeListeners = [];
  const makeArea = (name) => {
    const data = new Map();
    areas[name] = data;
    return {
      async get(key) {
        const keys = Array.isArray(key) ? key : [key];
        const out = {};
        for (const k of keys) if (data.has(k)) out[k] = structuredClone(data.get(k));
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data.get(k), newValue: structuredClone(v) };
          data.set(k, structuredClone(v));
        }
        for (const fn of changeListeners) fn(changes, name);
      },
      async remove(key) {
        const changes = { [key]: { oldValue: data.get(key) } };
        data.delete(key);
        for (const fn of changeListeners) fn(changes, name);
      },
    };
  };
  const listeners = { installed: [], startup: [], message: [] };
  const badge = {};
  const injections = [];
  const chrome = {
    storage: {
      sync: makeArea('sync'),
      local: makeArea('local'),
      onChanged: { addListener: (fn) => changeListeners.push(fn) },
    },
    runtime: {
      id: 'test-extension-id',
      getManifest: () => ({ version: '1.0.0' }),
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    action: {
      setBadgeText: async ({ text }) => { badge.text = text; },
      setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
      setBadgeTextColor: async ({ color }) => { badge.textColor = color; },
    },
    scripting: {
      executeScript: async (opts) => { injections.push(opts); return [{}]; },
    },
  };
  return { chrome, areas, listeners, badge, injections };
}

function bootWorker({ publicKey = publicJwk } = {}) {
  const fake = fakeChrome();
  let source = readFileSync(path.join(root, 'background.js'), 'utf8');
  // The shipped file has a placeholder; configure it like a real deployment would.
  assert.ok(source.includes('publicKeyJwk: null'), 'placeholder present in background.js');
  source = source.replace('publicKeyJwk: null', `publicKeyJwk: ${JSON.stringify(publicKey)}`);

  const sandbox = {
    chrome: fake.chrome,
    console,
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder, atob, btoa, URLSearchParams,
    fetch: async () => { throw new Error('network disabled in tests'); },
    setTimeout, clearTimeout,
    importScripts(...files) {
      for (const f of files) vm.runInContext(readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'background.js' });

  const send = (message) => new Promise((resolve) => {
    const handler = fake.listeners.message[0];
    const keepOpen = handler(message, { tab: { id: 7 } }, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
  return { ...fake, send, PDCM: sandbox.PDCM };
}

test('onInstalled seeds settings, badge follows the master toggle', async () => {
  const w = bootWorker();
  await w.listeners.installed[0]({ reason: 'install' });
  await new Promise((r) => setTimeout(r, 10));
  const settings = w.areas.sync.get(w.PDCM.STORAGE_KEYS.settings);
  assert.equal(settings.enabled, true);
  assert.equal(w.badge.text, 'ON');

  await w.chrome.storage.sync.set({ [w.PDCM.STORAGE_KEYS.settings]: { ...settings, enabled: false } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.badge.text, '');
});

test('license: activate valid key, reject bad key, status roams via sync, deactivate', async () => {
  const w = bootWorker();
  const { STORAGE_KEYS, MSG } = w.PDCM;

  const bad = await w.send({ type: MSG.LICENSE_ACTIVATE, key: 'PDCM.e30.e30' });
  assert.equal(bad.ok, true);
  assert.equal(bad.result.valid, false);
  assert.equal(bad.result.reason, 'bad-signature');
  assert.equal(w.areas.sync.has(STORAGE_KEYS.license), false, 'invalid keys are not stored');

  const key = await License.signLicense({ email: 'buyer@example.com' }, pair.privateJwk);
  const good = await w.send({ type: MSG.LICENSE_ACTIVATE, key: `  ${key}\n` });
  assert.equal(good.result.valid, true);
  assert.equal(good.result.email, 'buyer@example.com');
  assert.equal(w.areas.sync.get(STORAGE_KEYS.license).key, key);
  assert.equal(w.areas.local.get(STORAGE_KEYS.licenseStatus).valid, true);

  const status = await w.send({ type: MSG.LICENSE_STATUS });
  assert.equal(status.result.valid, true);

  // Simulate the key arriving from another synced device: status is re-derived.
  const other = await License.signLicense({ email: 'other@example.com' }, pair.privateJwk);
  await w.chrome.storage.sync.set({ [STORAGE_KEYS.license]: { key: other, activatedAt: 1 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.areas.local.get(STORAGE_KEYS.licenseStatus).email, 'other@example.com');

  const off = await w.send({ type: MSG.LICENSE_DEACTIVATE });
  assert.equal(off.result.valid, false);
  assert.equal(off.result.reason, 'none');
  assert.equal(w.areas.sync.has(STORAGE_KEYS.license), false);
});

test('license: unconfigured public key is reported as not-configured', async () => {
  const w = bootWorker({ publicKey: null });
  const key = await License.signLicense({ email: 'buyer@example.com' }, pair.privateJwk);
  const res = await w.send({ type: w.PDCM.MSG.LICENSE_ACTIVATE, key });
  assert.equal(res.result.valid, false);
  assert.equal(res.result.reason, 'not-configured');
});

test('inject-tab runs the page hook in MAIN world and the bridge in ISOLATED world', async () => {
  const w = bootWorker();
  const res = await w.send({ type: w.PDCM.MSG.INJECT_TAB, tabId: 12 });
  assert.equal(res.ok, true);
  const injections = JSON.parse(JSON.stringify(w.injections)); // cross-realm objects
  assert.equal(injections.length, 2);
  assert.deepEqual(injections[0].files, ['content.js']);
  assert.equal(injections[0].world, 'MAIN');
  assert.deepEqual(injections[1].files, ['lib/shared.js', 'bridge.js']);
  assert.equal(injections[1].world, 'ISOLATED');
  for (const i of injections) {
    assert.deepEqual(i.target, { tabId: 12, allFrames: true });
    assert.equal(i.injectImmediately, true);
  }
});

test('unknown messages are ignored (other listeners may handle them)', async () => {
  const w = bootWorker();
  const res = await w.send({ type: 'something-else' });
  assert.equal(res, undefined);
});
