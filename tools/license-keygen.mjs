#!/usr/bin/env node
/**
 * Generate the ECDSA P-256 key pair used to sign "Plague Doctor Pro" licenses.
 *
 *   node tools/license-keygen.mjs [--force]
 *
 * Writes
 *   tools/.secrets/license-private.jwk.json   (git-ignored — NEVER ship or commit)
 *   tools/.secrets/license-public.jwk.json
 * and prints the public JWK to paste into background.js → LICENSE_CONFIG.publicKeyJwk.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const License = require('../lib/license.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretsDir = path.join(root, 'tools', '.secrets');
const privatePath = path.join(secretsDir, 'license-private.jwk.json');
const publicPath = path.join(secretsDir, 'license-public.jwk.json');
const force = process.argv.includes('--force');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

if (!force && (await exists(privatePath))) {
  console.error(`Refusing to overwrite existing key: ${path.relative(root, privatePath)}\n` +
    'Rotating the key invalidates every license issued so far. Re-run with --force if that is intended.');
  process.exit(1);
}

const { publicJwk, privateJwk } = await License.generateKeyPair();
await mkdir(secretsDir, { recursive: true });
await writeFile(privatePath, JSON.stringify(privateJwk, null, 2) + '\n');
await chmod(privatePath, 0o600).catch(() => {});
await writeFile(publicPath, JSON.stringify(publicJwk, null, 2) + '\n');

const publicForCode = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };

console.log(`Key pair written to ${path.relative(root, secretsDir)}/ (private key is git-ignored).\n`);
console.log('Paste this into background.js → LICENSE_CONFIG.publicKeyJwk:\n');
console.log(`  publicKeyJwk: ${JSON.stringify(publicForCode)},\n`);
console.log('Then mint keys with:  node tools/license-sign.mjs --email customer@example.com');
