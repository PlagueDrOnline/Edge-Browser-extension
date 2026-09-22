import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PDCM = require('../lib/shared.js');

test('isSwitchId recognises Nintendo hardware ids', () => {
  assert.equal(PDCM.isSwitchId('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), true);
  assert.equal(PDCM.isSwitchId('Nintendo Co., Ltd. Pro Controller (Vendor: 057e Product: 2009)'), true);
  assert.equal(PDCM.isSwitchId('Joy-Con (L) (STANDARD GAMEPAD Vendor: 057e Product: 2006)'), true);
  assert.equal(PDCM.isSwitchId('057e-2007-Joy-Con (R)'), true);
  assert.equal(PDCM.isSwitchId('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), false);
  assert.equal(PDCM.isSwitchId('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), false);
});

test('describeGamepadId extracts name / vendor / product', () => {
  const d = PDCM.describeGamepadId('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)');
  assert.deepEqual(d, { name: 'Pro Controller', vendor: '057e', product: '2009', isSwitch: true });
  const x = PDCM.describeGamepadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)');
  assert.equal(x.name, 'Xbox 360 Controller');
  assert.equal(x.vendor, null);
  assert.equal(PDCM.describeGamepadId('').name, 'Unknown controller');
});

test('normalizeSettings fills defaults and rejects garbage', () => {
  const s = PDCM.normalizeSettings(null);
  assert.deepEqual(s, PDCM.DEFAULT_SETTINGS);

  const dirty = PDCM.normalizeSettings({
    enabled: 'yes',
    target: 'everything',
    disabledSites: ['WWW.Example.com', '', 'example.com', 42],
    profile: { mode: 'custom', map: [1, 0, 99, -1, 'x'] },
    keyboard: {
      enabled: true,
      deadzone: 5,
      leftStick: 'dpad',
      bindings: [{ button: 0, code: 'Space', key: ' ', keyCode: 32 }, { button: 40, code: 'KeyA' }, { code: '' }, null],
    },
  });
  assert.equal(dirty.enabled, true); // non-boolean -> default (true)
  assert.equal(dirty.target, 'switch');
  assert.deepEqual(dirty.disabledSites, ['example.com']);
  assert.equal(dirty.profile.mode, 'custom');
  assert.deepEqual(dirty.profile.map.slice(0, 5), [1, 0, 3, 2, 4]); // invalid entries fall back to the default map
  assert.equal(dirty.keyboard.deadzone, 0.95);
  assert.equal(dirty.keyboard.leftStick, 'none');
  assert.deepEqual(dirty.keyboard.bindings, [{ button: 0, code: 'Space', key: ' ', keyCode: 32 }]);
});

test('buildSwapMap swaps only the requested pairs', () => {
  assert.deepEqual(PDCM.buildSwapMap(true, true).slice(0, 4), [1, 0, 3, 2]);
  assert.deepEqual(PDCM.buildSwapMap(true, false).slice(0, 4), [1, 0, 2, 3]);
  assert.deepEqual(PDCM.buildSwapMap(false, true).slice(0, 4), [0, 1, 3, 2]);
  assert.ok(PDCM.isIdentityMap(PDCM.buildSwapMap(false, false)));
});

test('computeEffectiveConfig applies free tier, site rules and Pro gating', () => {
  const base = PDCM.normalizeSettings({ disabledSites: ['paused.example'] });

  const free = PDCM.computeEffectiveConfig(base, null, 'itch.io');
  assert.equal(free.pro, false);
  assert.equal(free.enabled, true);
  assert.deepEqual(free.map.slice(0, 4), [1, 0, 3, 2]);
  assert.equal(free.keyboard.enabled, false);

  const paused = PDCM.computeEffectiveConfig(base, null, 'www.paused.example');
  assert.equal(paused.siteEnabled, false);
  assert.equal(paused.enabled, false);

  const off = PDCM.computeEffectiveConfig({ ...base, enabled: false }, null, 'itch.io');
  assert.equal(off.enabled, false);

  const noSwaps = PDCM.computeEffectiveConfig({ ...base, swapAB: false, swapXY: false }, null, 'itch.io');
  assert.equal(noSwaps.enabled, false, 'identity map means nothing to do');

  // Pro features are ignored without a valid license…
  const proSettings = PDCM.normalizeSettings({
    profile: { mode: 'custom', map: [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0] },
    keyboard: { enabled: true, scope: 'sites', sites: ['itch.io'], bindings: [{ button: 0, code: 'Space', key: ' ', keyCode: 32 }] },
  });
  const locked = PDCM.computeEffectiveConfig(proSettings, { valid: false }, 'itch.io');
  assert.deepEqual(locked.map.slice(0, 4), [1, 0, 3, 2]);
  assert.equal(locked.profileMode, 'default');
  assert.equal(locked.keyboard.enabled, false);

  // …and honoured with one.
  const unlocked = PDCM.computeEffectiveConfig(proSettings, { valid: true }, 'itch.io');
  assert.equal(unlocked.map[0], 16);
  assert.equal(unlocked.profileMode, 'custom');
  assert.equal(unlocked.keyboard.enabled, true);
  assert.equal(unlocked.keyboard.bindings.length, 1);

  const otherSite = PDCM.computeEffectiveConfig(proSettings, { valid: true }, 'example.com');
  assert.equal(otherSite.keyboard.enabled, false, 'keyboard allow-list is per site');

  const everywhere = PDCM.computeEffectiveConfig({ ...proSettings, keyboard: { ...proSettings.keyboard, scope: 'all' } }, { valid: true }, 'example.com');
  assert.equal(everywhere.keyboard.enabled, true);

  const page = PDCM.toPageConfig(unlocked);
  assert.deepEqual(Object.keys(page).sort(), ['enabled', 'keyboard', 'map', 'target']);
});
