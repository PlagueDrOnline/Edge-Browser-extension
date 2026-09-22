/**
 * Plague Doctor Controller Mapper — offline license keys.
 *
 * A "Plague Doctor Pro" key is a compact signed token:
 *
 *     PDCM.<base64url(payload JSON)>.<base64url(ECDSA P-256 / SHA-256 signature)>
 *
 *     payload = { v: 1, id, plan: "pro", email, iat: <unix seconds>, exp: <unix seconds | null> }
 *
 * The extension ships only the PUBLIC key (background.js → LICENSE_CONFIG.publicKeyJwk)
 * and verifies keys locally with WebCrypto — no server, no telemetry. Keys are
 * minted with the PRIVATE key by tools/license-sign.mjs (or by your own
 * fulfilment webhook using the same `signLicense` function).
 *
 * Runs unchanged in the MV3 service worker (importScripts), in Node ≥ 18
 * (require) and in the browser (<script>).
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PDCMLicense = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const KEY_PREFIX = 'PDCM';
  const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is not available in this context');
    return c.subtle;
  }

  // ---- base64url -----------------------------------------------------------
  function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToBytes(str) {
    const normalized = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ---- key parsing ---------------------------------------------------------
  /** Accepts keys pasted with surrounding/embedded whitespace or line breaks. */
  function normalizeKeyString(input) {
    return String(input || '').replace(/\s+/g, '');
  }

  function parseLicenseKey(raw) {
    const key = normalizeKeyString(raw);
    const parts = key.split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX || !parts[1] || !parts[2]) {
      throw new Error('malformed');
    }
    let payloadBytes;
    let signature;
    let payload;
    try {
      payloadBytes = base64UrlToBytes(parts[1]);
      signature = base64UrlToBytes(parts[2]);
      payload = JSON.parse(textDecoder.decode(payloadBytes));
    } catch (_) {
      throw new Error('malformed');
    }
    if (!payload || typeof payload !== 'object') throw new Error('malformed');
    return { key, payload, payloadBytes, signature };
  }

  // ---- WebCrypto -------------------------------------------------------------
  function importPublicKey(jwk) {
    return subtle().importKey('jwk', jwk, KEY_ALGORITHM, true, ['verify']);
  }

  function importPrivateKey(jwk) {
    return subtle().importKey('jwk', jwk, KEY_ALGORITHM, true, ['sign']);
  }

  async function generateKeyPair() {
    const pair = await subtle().generateKey(KEY_ALGORITHM, true, ['sign', 'verify']);
    const [publicJwk, privateJwk] = await Promise.all([
      subtle().exportKey('jwk', pair.publicKey),
      subtle().exportKey('jwk', pair.privateKey),
    ]);
    return { publicJwk, privateJwk };
  }

  function randomId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return 'lic_' + c.randomUUID().replace(/-/g, '').slice(0, 20);
    return 'lic_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }

  /**
   * Mint a license key. `expiresAt` may be a Date, ISO string, unix seconds, or null.
   */
  async function signLicense({ email, plan = 'pro', expiresAt = null, id = null }, privateJwk) {
    if (!privateJwk) throw new Error('privateJwk is required');
    const exp = expiresAt == null
      ? null
      : typeof expiresAt === 'number'
        ? Math.floor(expiresAt)
        : Math.floor(new Date(expiresAt).getTime() / 1000);
    if (exp !== null && !Number.isFinite(exp)) throw new Error('invalid expiresAt');

    const payload = {
      v: 1,
      id: id || randomId(),
      plan,
      email: email ? String(email).trim().toLowerCase() : null,
      iat: Math.floor(Date.now() / 1000),
      exp,
    };
    const payloadBytes = textEncoder.encode(JSON.stringify(payload));
    const key = await importPrivateKey(privateJwk);
    const signature = new Uint8Array(await subtle().sign(SIGN_ALGORITHM, key, payloadBytes));
    return `${KEY_PREFIX}.${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(signature)}`;
  }

  /**
   * Verify a key against the embedded public key.
   * Never throws; returns { valid, reason, email, plan, issuedAt, expiresAt, licenseId }.
   * reasons: ok | not-configured | malformed | bad-signature | unsupported | expired | error
   */
  async function verifySignedLicense(rawKey, publicJwk, nowMs = Date.now()) {
    const result = { valid: false, reason: 'error', email: null, plan: null, issuedAt: null, expiresAt: null, licenseId: null };
    if (!publicJwk || typeof publicJwk !== 'object') return { ...result, reason: 'not-configured' };

    let parsed;
    try {
      parsed = parseLicenseKey(rawKey);
    } catch (_) {
      return { ...result, reason: 'malformed' };
    }

    try {
      const key = await importPublicKey(publicJwk);
      const ok = await subtle().verify(SIGN_ALGORITHM, key, parsed.signature, parsed.payloadBytes);
      if (!ok) return { ...result, reason: 'bad-signature' };
    } catch (_) {
      return { ...result, reason: 'error' };
    }

    const p = parsed.payload;
    const info = {
      email: typeof p.email === 'string' ? p.email : null,
      plan: typeof p.plan === 'string' ? p.plan : null,
      issuedAt: Number.isFinite(p.iat) ? p.iat : null,
      expiresAt: Number.isFinite(p.exp) ? p.exp : null,
      licenseId: typeof p.id === 'string' ? p.id : null,
    };
    if (p.v !== 1 || info.plan !== 'pro') return { ...result, ...info, reason: 'unsupported' };
    if (info.expiresAt !== null && nowMs / 1000 > info.expiresAt) return { ...result, ...info, reason: 'expired' };
    return { ...result, ...info, valid: true, reason: 'ok' };
  }

  return {
    KEY_PREFIX,
    KEY_ALGORITHM,
    SIGN_ALGORITHM,
    bytesToBase64Url,
    base64UrlToBytes,
    normalizeKeyString,
    parseLicenseKey,
    generateKeyPair,
    signLicense,
    verifySignedLicense,
  };
});
