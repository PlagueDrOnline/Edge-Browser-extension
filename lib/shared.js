/**
 * Plague Doctor Controller Mapper — shared constants & helpers.
 *
 * Loaded by:
 *   - background.js   (service worker, via importScripts)
 *   - bridge.js       (isolated-world content script, listed before it in manifest.json)
 *   - popup.html      (regular <script>)
 *   - tests/          (Node, via require)
 *
 * NOT loaded by content.js (MAIN world) on purpose: nothing from here may leak
 * into the page's global scope. content.js duplicates the two constants it needs.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PDCM = Object.assign(root.PDCM || {}, api);
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STANDARD_BUTTON_COUNT = 17;

  /** chrome.storage keys (sync unless stated otherwise). */
  const STORAGE_KEYS = Object.freeze({
    settings: 'pdcm.settings',
    license: 'pdcm.license',
    licenseStatus: 'pdcm.licenseStatus', // chrome.storage.local (device-specific cache)
  });

  /** chrome.runtime message types. */
  const MSG = Object.freeze({
    PAGE_STATUS: 'pdcm:page-status',
    INJECT_TAB: 'pdcm:inject-tab',
    LICENSE_STATUS: 'pdcm:license-status',
    LICENSE_ACTIVATE: 'pdcm:license-activate',
    LICENSE_DEACTIVATE: 'pdcm:license-deactivate',
  });

  /** window.postMessage channel between bridge.js (isolated) and content.js (page). */
  const PAGE_CHANNEL = 'plague-doctor-controller-mapper';

  /**
   * W3C "standard" gamepad layout. Index = what web games read from
   * gamepad.buttons[index]. Labels show how the same physical position is
   * printed on Xbox-style pads vs. Nintendo Switch pads.
   */
  const STANDARD_BUTTONS = Object.freeze([
    { index: 0, name: 'A', xbox: 'A', nintendo: 'B', position: 'Bottom face button' },
    { index: 1, name: 'B', xbox: 'B', nintendo: 'A', position: 'Right face button' },
    { index: 2, name: 'X', xbox: 'X', nintendo: 'Y', position: 'Left face button' },
    { index: 3, name: 'Y', xbox: 'Y', nintendo: 'X', position: 'Top face button' },
    { index: 4, name: 'LB', xbox: 'LB', nintendo: 'L', position: 'Left bumper' },
    { index: 5, name: 'RB', xbox: 'RB', nintendo: 'R', position: 'Right bumper' },
    { index: 6, name: 'LT', xbox: 'LT', nintendo: 'ZL', position: 'Left trigger' },
    { index: 7, name: 'RT', xbox: 'RT', nintendo: 'ZR', position: 'Right trigger' },
    { index: 8, name: 'Back', xbox: 'View', nintendo: '−', position: 'Select / Back' },
    { index: 9, name: 'Start', xbox: 'Menu', nintendo: '+', position: 'Start' },
    { index: 10, name: 'L3', xbox: 'LS', nintendo: 'L-stick', position: 'Left stick click' },
    { index: 11, name: 'R3', xbox: 'RS', nintendo: 'R-stick', position: 'Right stick click' },
    { index: 12, name: 'D-Up', xbox: 'D-Up', nintendo: 'D-Up', position: 'D-pad up' },
    { index: 13, name: 'D-Down', xbox: 'D-Down', nintendo: 'D-Down', position: 'D-pad down' },
    { index: 14, name: 'D-Left', xbox: 'D-Left', nintendo: 'D-Left', position: 'D-pad left' },
    { index: 15, name: 'D-Right', xbox: 'D-Right', nintendo: 'D-Right', position: 'D-pad right' },
    { index: 16, name: 'Home', xbox: 'Guide', nintendo: 'Home', position: 'Home / Guide' },
  ]);

  const IDENTITY_MAP = Object.freeze(
    Array.from({ length: STANDARD_BUTTON_COUNT }, (_, i) => i)
  );

  /**
   * Matches the `Gamepad.id` string Chromium/Edge produce for Nintendo hardware,
   * e.g. "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)".
   * 057e = Nintendo's USB vendor id (Pro Controller 2009, Joy-Con L 2006,
   * Joy-Con R 2007, Charging Grip 200e, NSO SNES 2017, NSO N64 2019).
   * Keep in sync with the copy in content.js.
   */
  const SWITCH_ID_PATTERN = /vendor:\s*057e|nintendo|\bswitch\b|pro controller|joy-?con/i;

  const DEFAULT_SETTINGS = Object.freeze({
    version: SCHEMA_VERSION,
    /** Master switch — "Plague Remap". */
    enabled: true,
    swapAB: true,
    swapXY: true,
    /** Which pads get remapped: only detected Switch hardware, or everything. */
    target: 'switch', // 'switch' | 'all'
    /** Hosts (normalised, top-level site) where the remap is paused. */
    disabledSites: [],
    /** Pro — custom button matrix. map[outputIndex] = physicalIndex. */
    profile: {
      mode: 'default', // 'default' (A/B & X/Y swap) | 'custom'
      name: 'My profile',
      map: [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    },
    /** Pro — gamepad → keyboard translation. */
    keyboard: {
      enabled: false,
      scope: 'sites', // 'sites' (allow-list) | 'all'
      sites: [],
      dpadArrows: true,
      leftStick: 'none', // 'none' | 'arrows' | 'wasd'
      deadzone: 0.5,
      /** { button: <output index>, key, code, keyCode } */
      bindings: [],
    },
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** "www.Example.com" -> "example.com" */
  function normalizeHost(host) {
    return String(host || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
  }

  function isSwitchId(id) {
    return SWITCH_ID_PATTERN.test(String(id || ''));
  }

  /**
   * Human friendly name from a gamepad id string, e.g.
   *   "Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)"
   *   -> { name: "Pro Controller", vendor: "057e", product: "2009", isSwitch: true }
   */
  function describeGamepadId(id) {
    const str = String(id || '').trim();
    const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(str);
    const name = (paren ? paren[1] : str).trim() || 'Unknown controller';
    const vp = /vendor:\s*([0-9a-f]{4})\s*product:\s*([0-9a-f]{4})/i.exec(str);
    return {
      name,
      vendor: vp ? vp[1].toLowerCase() : null,
      product: vp ? vp[2].toLowerCase() : null,
      isSwitch: isSwitchId(str),
    };
  }

  function sanitizeMap(candidate, fallback) {
    const base = Array.isArray(fallback) && fallback.length === STANDARD_BUTTON_COUNT
      ? fallback.slice()
      : IDENTITY_MAP.slice();
    if (!Array.isArray(candidate)) return base;
    return base.map((def, i) => {
      const v = Number(candidate[i]);
      return Number.isInteger(v) && v >= 0 && v < STANDARD_BUTTON_COUNT ? v : def;
    });
  }

  const HOST_PATTERN = /^[a-z0-9.\-:[\]]{1,253}$/; // ASCII hostnames (IDN arrives punycoded) + IPv6 literals

  function sanitizeSites(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const h = normalizeHost(item);
      if (h && HOST_PATTERN.test(h) && !out.includes(h)) out.push(h);
    }
    return out.slice(0, 500);
  }

  function sanitizeBinding(b) {
    if (!isObject(b)) return null;
    const button = Number(b.button);
    const code = typeof b.code === 'string' ? b.code.slice(0, 40) : '';
    if (!Number.isInteger(button) || button < 0 || button >= STANDARD_BUTTON_COUNT || !code) return null;
    const keyCode = Number(b.keyCode);
    return {
      button,
      code,
      key: typeof b.key === 'string' && b.key ? b.key.slice(0, 40) : code,
      keyCode: Number.isInteger(keyCode) && keyCode >= 0 && keyCode <= 255 ? keyCode : 0,
    };
  }

  /**
   * Deep-merge `raw` (whatever is in storage) onto DEFAULT_SETTINGS and coerce
   * every field to a valid value. Always returns a fresh, safe object.
   */
  function normalizeSettings(raw) {
    const src = isObject(raw) ? raw : {};
    const d = DEFAULT_SETTINGS;
    const profileSrc = isObject(src.profile) ? src.profile : {};
    const kbSrc = isObject(src.keyboard) ? src.keyboard : {};

    const bindings = Array.isArray(kbSrc.bindings)
      ? kbSrc.bindings.map(sanitizeBinding).filter(Boolean).slice(0, 64)
      : [];

    return {
      version: SCHEMA_VERSION,
      enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
      swapAB: typeof src.swapAB === 'boolean' ? src.swapAB : d.swapAB,
      swapXY: typeof src.swapXY === 'boolean' ? src.swapXY : d.swapXY,
      target: src.target === 'all' ? 'all' : 'switch',
      disabledSites: sanitizeSites(src.disabledSites),
      profile: {
        mode: profileSrc.mode === 'custom' ? 'custom' : 'default',
        name: typeof profileSrc.name === 'string' && profileSrc.name.trim()
          ? profileSrc.name.trim().slice(0, 60)
          : d.profile.name,
        map: sanitizeMap(profileSrc.map, d.profile.map),
      },
      keyboard: {
        enabled: kbSrc.enabled === true,
        scope: kbSrc.scope === 'all' ? 'all' : 'sites',
        sites: sanitizeSites(kbSrc.sites),
        dpadArrows: typeof kbSrc.dpadArrows === 'boolean' ? kbSrc.dpadArrows : d.keyboard.dpadArrows,
        leftStick: ['none', 'arrows', 'wasd'].includes(kbSrc.leftStick) ? kbSrc.leftStick : 'none',
        deadzone: Number.isFinite(Number(kbSrc.deadzone))
          ? clamp(Number(kbSrc.deadzone), 0.1, 0.95)
          : d.keyboard.deadzone,
        bindings,
      },
    };
  }

  /** Button map produced by the free tier toggles. */
  function buildSwapMap(swapAB, swapXY) {
    const map = IDENTITY_MAP.slice();
    if (swapAB) { map[0] = 1; map[1] = 0; }
    if (swapXY) { map[2] = 3; map[3] = 2; }
    return map;
  }

  function isIdentityMap(map) {
    return Array.isArray(map) && map.every((v, i) => v === i);
  }

  /**
   * The configuration that actually applies on a given site, with Pro gating
   * applied. This is what bridge.js hands to the page hook and what the popup
   * displays. `licenseStatus` is the object cached by background.js.
   */
  function computeEffectiveConfig(settings, licenseStatus, siteHost) {
    const s = normalizeSettings(settings);
    const pro = !!(licenseStatus && licenseStatus.valid === true);
    const host = normalizeHost(siteHost);

    const siteEnabled = !host || !s.disabledSites.includes(host);
    const useCustom = pro && s.profile.mode === 'custom';
    const map = useCustom ? s.profile.map.slice() : buildSwapMap(s.swapAB, s.swapXY);
    const remapEnabled = s.enabled && siteEnabled && !isIdentityMap(map);

    const kb = s.keyboard;
    const keyboardSiteAllowed = kb.scope === 'all' || (!!host && kb.sites.includes(host));
    const keyboardEnabled = pro && kb.enabled && keyboardSiteAllowed && siteEnabled;

    return {
      pro,
      host,
      siteEnabled,
      keyboardSiteAllowed,
      profileMode: useCustom ? 'custom' : 'default',
      // ---- everything below is consumed by content.js ----
      enabled: remapEnabled,
      target: s.target,
      map,
      keyboard: {
        enabled: keyboardEnabled,
        dpadArrows: kb.dpadArrows,
        leftStick: kb.leftStick,
        deadzone: kb.deadzone,
        bindings: kb.bindings.map((b) => ({ ...b })),
      },
    };
  }

  /** Strip everything the page hook doesn't need before posting it. */
  function toPageConfig(effective) {
    return {
      enabled: effective.enabled,
      target: effective.target,
      map: effective.map,
      keyboard: effective.keyboard,
    };
  }

  return {
    SCHEMA_VERSION,
    STANDARD_BUTTON_COUNT,
    STORAGE_KEYS,
    MSG,
    PAGE_CHANNEL,
    STANDARD_BUTTONS,
    IDENTITY_MAP,
    SWITCH_ID_PATTERN,
    DEFAULT_SETTINGS,
    normalizeHost,
    isSwitchId,
    describeGamepadId,
    normalizeSettings,
    sanitizeBinding,
    buildSwapMap,
    isIdentityMap,
    computeEffectiveConfig,
    toPageConfig,
  };
});
