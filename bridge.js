/**
 * Plague Doctor Controller Mapper — isolated-world bridge.
 *
 * Runs as a normal content script (isolated world, document_start, all frames)
 * and is the only piece with access to chrome.storage / chrome.runtime. It
 *   1. resolves the user's settings + license into the config that applies on
 *      this site (lib/shared.js → computeEffectiveConfig),
 *   2. hands that config to the page hook (content.js, MAIN world) over
 *      window.postMessage and re-sends it whenever storage changes,
 *   3. answers diagnostics requests from the popup.
 *
 * lib/shared.js is listed before this file in manifest.json, so `PDCM` exists.
 */
(() => {
  'use strict';

  if (globalThis.__pdcmBridgeInstalled) return;
  globalThis.__pdcmBridgeInstalled = true;

  const { STORAGE_KEYS, MSG, PAGE_CHANNEL, normalizeHost, computeEffectiveConfig, toPageConfig } = globalThis.PDCM;

  const isTopFrame = window === window.top;
  let hookReady = false;
  let hookVersion = null;
  let lastEffective = null;
  let requestSeq = 0;
  const pendingStatus = new Map(); // requestId -> resolve

  /**
   * Site rules apply to the top-level site the user sees in the address bar,
   * so a game embedded from html-classic.itch.zone inside itch.io still follows
   * the itch.io rule. ancestorOrigins is available in all Chromium browsers.
   */
  function resolveSiteHost() {
    try {
      const ancestors = location.ancestorOrigins;
      if (!isTopFrame && ancestors && ancestors.length) {
        const top = ancestors[ancestors.length - 1];
        if (top && top !== 'null') return normalizeHost(new URL(top).hostname);
      }
    } catch (_) { /* fall through */ }
    return normalizeHost(location.hostname);
  }
  const siteHost = resolveSiteHost();

  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function postToPage(type, payload) {
    window.postMessage({ channel: PAGE_CHANNEL, dir: 'to-page', type, ...payload }, '*');
  }

  async function readState() {
    const [sync, local] = await Promise.all([
      chrome.storage.sync.get(STORAGE_KEYS.settings),
      chrome.storage.local.get(STORAGE_KEYS.licenseStatus),
    ]);
    return {
      settings: sync[STORAGE_KEYS.settings],
      licenseStatus: local[STORAGE_KEYS.licenseStatus],
    };
  }

  async function pushConfig() {
    if (!contextAlive()) return;
    try {
      const { settings, licenseStatus } = await readState();
      lastEffective = computeEffectiveConfig(settings, licenseStatus, siteHost);
      postToPage('config', { config: toPageConfig(lastEffective) });
    } catch (err) {
      // "Extension context invalidated" after an update/reload of the extension — nothing to do.
    }
  }

  function requestPageStatus(timeoutMs = 300) {
    return new Promise((resolve) => {
      const requestId = ++requestSeq;
      const timer = setTimeout(() => { pendingStatus.delete(requestId); resolve(null); }, timeoutMs);
      pendingStatus.set(requestId, (status) => { clearTimeout(timer); resolve(status); });
      postToPage('status-request', { requestId });
    });
  }

  // ---- page hook → bridge --------------------------------------------------
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.channel !== PAGE_CHANNEL || data.dir !== 'to-extension') return;
    if (data.type === 'ready') {
      hookReady = true;
      hookVersion = data.version || null;
      pushConfig();
    } else if (data.type === 'status' && pendingStatus.has(data.requestId)) {
      const resolve = pendingStatus.get(data.requestId);
      pendingStatus.delete(data.requestId);
      resolve(data.status || null);
    }
  }, false);

  // ---- storage → page ------------------------------------------------------
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      (area === 'sync' && changes[STORAGE_KEYS.settings]) ||
      (area === 'local' && changes[STORAGE_KEYS.licenseStatus])
    ) {
      pushConfig();
    }
  });

  // ---- popup / background → bridge ----------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MSG.PAGE_STATUS) return undefined;
    // Only the top frame answers; sub-frames stay quiet so the popup gets one reply.
    if (!isTopFrame) return undefined;

    (async () => {
      const page = await requestPageStatus();
      sendResponse({
        ok: true,
        host: normalizeHost(location.hostname),
        siteHost,
        url: location.href,
        hookReady: hookReady || !!page,
        hookVersion: (page && page.version) || hookVersion,
        effective: lastEffective,
        page,
      });
    })();
    return true; // async response
  });

  pushConfig();
})();
