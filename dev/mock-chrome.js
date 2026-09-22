/**
 * DEV ONLY — a fake `chrome.*` API + fake gamepad so popup.html can be opened
 * in a normal browser tab (dev/preview.html) without loading the extension.
 * Not part of the packaged extension (see tools/package.sh).
 *
 * Scenario is read from the frame's query string:
 *   ?pro=1        Pro license active
 *   ?bridge=0     content script not present in the "tab"
 *   ?url=edge://  restricted page
 */
(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  const scenario = {
    pro: params.get('pro') === '1',
    bridge: params.get('bridge') !== '0',
    url: params.get('url') || 'https://itch.io/games/html5',
    host: 'itch.io',
  };

  const SWITCH_ID = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';
  const pad = {
    id: SWITCH_ID, index: 0, connected: true, mapping: 'standard', timestamp: 1, axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  let padVisible = false;
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => (padVisible ? [pad, null, null, null] : [null, null, null, null]) });

  const areas = { sync: new Map(), local: new Map() };
  const changeListeners = [];
  const area = (name) => ({
    async get(key) { const out = {}; if (areas[name].has(key)) out[key] = structuredClone(areas[name].get(key)); return out; },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: areas[name].get(k), newValue: structuredClone(v) }; areas[name].set(k, structuredClone(v)); }
      changeListeners.forEach((fn) => fn(changes, name));
    },
    async remove(key) { areas[name].delete(key); },
  });

  let license = scenario.pro
    ? { valid: true, reason: 'ok', email: 'you@example.com', expiresAt: null }
    : { valid: false, reason: 'none' };

  const chrome = {
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (fn) => changeListeners.push(fn) } },
    runtime: {
      id: 'dev-preview',
      getManifest: () => ({ version: '1.0.0-preview' }),
      async sendMessage(msg) {
        switch (msg.type) {
          case 'pdcm:license-status': return { ok: true, result: license };
          case 'pdcm:license-activate': {
            // In the preview any key starting with "PDCM." is accepted.
            const ok = /^PDCM\./.test(msg.key.trim());
            license = ok ? { valid: true, reason: 'ok', email: 'you@example.com', expiresAt: null } : { valid: false, reason: 'bad-signature' };
            return { ok: true, result: license };
          }
          case 'pdcm:license-deactivate': license = { valid: false, reason: 'none' }; return { ok: true, result: license };
          case 'pdcm:inject-tab': scenario.bridge = true; return { ok: true, result: { ok: true } };
          default: return { ok: false, error: 'unknown message' };
        }
      },
    },
    tabs: {
      async query() { return [{ id: 1, url: scenario.url }]; },
      async sendMessage() {
        if (!scenario.bridge) throw new Error('Could not establish connection. Receiving end does not exist.');
        const PDCM = window.PDCM;
        const effective = PDCM.computeEffectiveConfig(areas.sync.get('pdcm.settings'), license, scenario.host);
        return {
          ok: true, host: scenario.host, siteHost: scenario.host, url: scenario.url, hookReady: true, hookVersion: '1.0.0', effective,
          page: { version: '1.0.0', remapActive: effective.enabled, keyboardActive: effective.keyboard.enabled, calls: 1337, lastCallAgoMs: 16, remapped: padVisible ? [{ index: 0, id: SWITCH_ID }] : [] },
        };
      },
    },
  };

  window.chrome = chrome;
  window.__pdcmMock = {
    scenario,
    /** Simulate a physical press on the fake Switch pad (standard index). */
    press(index, ms = 350) {
      padVisible = true;
      pad.buttons[index] = { pressed: true, touched: true, value: 1 };
      pad.timestamp++;
      setTimeout(() => { pad.buttons[index] = { pressed: false, touched: false, value: 0 }; pad.timestamp++; }, ms);
    },
    connectPad() { padVisible = true; pad.timestamp++; },
    disconnectPad() { padVisible = false; },
  };
})();
