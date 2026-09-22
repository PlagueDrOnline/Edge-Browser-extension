/**
 * Plague Doctor Controller Mapper — MV3 service worker.
 *
 * Responsibilities
 *   - seed / migrate settings on install & update
 *   - keep the toolbar badge in sync with the master toggle
 *   - own the "Plague Doctor Pro" license lifecycle (activate, verify, cache)
 *   - inject the hook into tabs that were open before the extension was installed
 *
 * The worker is event-driven and may be terminated at any time; everything it
 * needs is re-read from chrome.storage.
 */
/* global importScripts */
importScripts('lib/shared.js', 'lib/license.js');

const { STORAGE_KEYS, MSG, normalizeSettings } = self.PDCM;
const License = self.PDCMLicense;

// -----------------------------------------------------------------------------
// Monetisation configuration
// -----------------------------------------------------------------------------
const LICENSE_CONFIG = Object.freeze({
  /**
   * 'signed'  — offline keys signed with your private key (default, no server).
   *             Run `node tools/license-keygen.mjs` once and paste the public
   *             JWK below; mint keys with `node tools/license-sign.mjs`.
   * 'gumroad' — verify Gumroad-generated license keys against Gumroad's API
   *             (one-time payment product with "Generate license keys" enabled).
   *             Requires "https://api.gumroad.com/*" in manifest host_permissions
   *             and in the extension_pages CSP connect-src.
   * 'remote'  — POST { key } to your own endpoint (Stripe / Lemon Squeezy / …)
   *             and expect { valid, email, plan, expiresAt, reason } back.
   */
  provider: 'signed',

  // TODO: paste the output of `node tools/license-keygen.mjs` here, e.g.
  // publicKeyJwk: { kty: 'EC', crv: 'P-256', x: '…', y: '…' },
  publicKeyJwk: null,

  gumroad: {
    endpoint: 'https://api.gumroad.com/v2/licenses/verify',
    productId: '[YOUR-GUMROAD-PRODUCT-ID]',
  },
  remote: {
    url: 'https://[YOUR-LICENSE-API]/v1/validate',
  },

  /** Remote providers are re-checked this often (offline grace period applies). */
  revalidateAfterMs: 7 * 24 * 60 * 60 * 1000,
});

const BADGE = Object.freeze({
  on: { text: 'ON', color: '#19e6c1', textColor: '#0b0d10' },
  off: { text: '', color: '#c1121f', textColor: '#ffffff' },
});

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------
async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEYS.settings);
  return normalizeSettings(stored[STORAGE_KEYS.settings]);
}

async function ensureSettings() {
  const settings = await getSettings(); // normalizes + migrates whatever is there
  await chrome.storage.sync.set({ [STORAGE_KEYS.settings]: settings });
  return settings;
}

async function updateBadge(settings) {
  const s = settings || (await getSettings());
  const badge = s.enabled ? BADGE.on : BADGE.off;
  try {
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: badge.textColor });
  } catch (_) { /* action API unavailable (should not happen in MV3) */ }
}

// -----------------------------------------------------------------------------
// License
// -----------------------------------------------------------------------------
const INVALID = (reason, extra = {}) => ({
  valid: false,
  reason,
  email: null,
  plan: null,
  expiresAt: null,
  provider: LICENSE_CONFIG.provider,
  checkedAt: Date.now(),
  ...extra,
});

async function verifyWithProvider(key) {
  const provider = LICENSE_CONFIG.provider;
  const trimmed = License.normalizeKeyString(key);
  if (!trimmed) return INVALID('malformed');

  if (provider === 'signed') {
    const r = await License.verifySignedLicense(trimmed, LICENSE_CONFIG.publicKeyJwk);
    return { ...r, provider, checkedAt: Date.now() };
  }

  if (provider === 'gumroad') {
    const { endpoint, productId } = LICENSE_CONFIG.gumroad;
    if (!productId || productId.startsWith('[')) return INVALID('not-configured');
    const body = new URLSearchParams({ product_id: productId, license_key: trimmed, increment_uses_count: 'false' });
    let res;
    try {
      res = await fetch(endpoint, { method: 'POST', body });
    } catch (_) {
      return INVALID('network');
    }
    if (res.status === 404) return INVALID('bad-signature'); // Gumroad: unknown key
    if (!res.ok) return INVALID('network');
    const data = await res.json().catch(() => null);
    const p = data && data.purchase;
    if (!data || data.success !== true || !p) return INVALID('bad-signature');
    if (p.refunded || p.chargebacked || p.disputed) return INVALID('revoked');
    return {
      valid: true,
      reason: 'ok',
      email: p.email || null,
      plan: 'pro',
      expiresAt: null,
      licenseId: p.sale_id || null,
      provider,
      checkedAt: Date.now(),
    };
  }

  if (provider === 'remote') {
    const { url } = LICENSE_CONFIG.remote;
    if (!url || url.includes('[')) return INVALID('not-configured');
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: trimmed, extension: chrome.runtime.id, version: chrome.runtime.getManifest().version }),
      });
    } catch (_) {
      return INVALID('network');
    }
    if (!res.ok) return INVALID('network');
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return INVALID('network');
    return {
      valid: data.valid === true,
      reason: data.valid === true ? 'ok' : String(data.reason || 'bad-signature'),
      email: data.email || null,
      plan: data.plan || 'pro',
      expiresAt: Number.isFinite(data.expiresAt) ? data.expiresAt : null,
      licenseId: data.licenseId || null,
      provider,
      checkedAt: Date.now(),
    };
  }

  return INVALID('not-configured');
}

async function readStoredLicense() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(STORAGE_KEYS.license),
    chrome.storage.local.get(STORAGE_KEYS.licenseStatus),
  ]);
  return { license: sync[STORAGE_KEYS.license] || null, status: local[STORAGE_KEYS.licenseStatus] || null };
}

async function writeStatus(status) {
  await chrome.storage.local.set({ [STORAGE_KEYS.licenseStatus]: status });
  return status;
}

/**
 * Re-derive the cached license status from the stored key.
 * Offline (signed) keys are always re-verified — it is instant. Remote
 * providers are only re-checked after `revalidateAfterMs` unless forced, and a
 * network failure keeps the previous status (offline grace).
 */
async function refreshLicenseStatus({ force = false } = {}) {
  const { license, status } = await readStoredLicense();
  if (!license || !license.key) return writeStatus(INVALID('none'));

  const isRemote = LICENSE_CONFIG.provider !== 'signed';
  if (!force && isRemote && status && status.valid && Date.now() - (status.checkedAt || 0) < LICENSE_CONFIG.revalidateAfterMs) {
    return status;
  }

  const fresh = await verifyWithProvider(license.key);
  if (fresh.reason === 'network' && status && status.valid) {
    return writeStatus({ ...status, lastError: 'network', lastErrorAt: Date.now() });
  }
  return writeStatus(fresh);
}

async function activateLicense(key) {
  const result = await verifyWithProvider(key);
  if (!result.valid) return result;
  await chrome.storage.sync.set({
    [STORAGE_KEYS.license]: { key: License.normalizeKeyString(key), activatedAt: Date.now() },
  });
  return writeStatus(result);
}

async function deactivateLicense() {
  await chrome.storage.sync.remove(STORAGE_KEYS.license);
  return writeStatus(INVALID('none'));
}

// -----------------------------------------------------------------------------
// On-demand injection (tabs opened before install, or after "Activate on this tab")
// -----------------------------------------------------------------------------
async function injectIntoTab(tabId) {
  const target = { tabId, allFrames: true };
  await chrome.scripting.executeScript({ target, files: ['content.js'], world: 'MAIN', injectImmediately: true });
  await chrome.scripting.executeScript({ target, files: ['lib/shared.js', 'bridge.js'], world: 'ISOLATED', injectImmediately: true });
  return { ok: true };
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async (details) => {
  const settings = await ensureSettings();
  await Promise.all([updateBadge(settings), refreshLicenseStatus({ force: details.reason === 'update' })]);
});

chrome.runtime.onStartup.addListener(async () => {
  await Promise.all([updateBadge(), refreshLicenseStatus()]);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes[STORAGE_KEYS.settings]) {
    updateBadge(normalizeSettings(changes[STORAGE_KEYS.settings].newValue));
  }
  // A key activated on another synced device (or removed there) — follow it.
  if (area === 'sync' && changes[STORAGE_KEYS.license]) {
    refreshLicenseStatus({ force: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined;

  const handlers = {
    [MSG.LICENSE_STATUS]: () => refreshLicenseStatus({ force: !!message.force }),
    [MSG.LICENSE_ACTIVATE]: () => activateLicense(String(message.key || '')),
    [MSG.LICENSE_DEACTIVATE]: () => deactivateLicense(),
    [MSG.INJECT_TAB]: () => {
      const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab && sender.tab.id;
      if (!Number.isInteger(tabId)) throw new Error('No tab id');
      return injectIntoTab(tabId);
    },
  };

  const handler = handlers[message.type];
  if (!handler) return undefined;

  Promise.resolve()
    .then(handler)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true; // keep the channel open for the async response
});

// Cheap safety net: make sure the badge is right whenever the worker wakes up.
updateBadge();
