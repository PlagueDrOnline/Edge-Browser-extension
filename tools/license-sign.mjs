#!/usr/bin/env node
/**
 * Mint a "Plague Doctor Pro" license key (offline, signed with your private key).
 *
 *   node tools/license-sign.mjs --email customer@example.com
 *   node tools/license-sign.mjs --email customer@example.com --expires 2027-12-31
 *   node tools/license-sign.mjs --email customer@example.com --id lic_order_1234 --json
 *
 * Options
 *   --email     customer e-mail embedded in the key (shown in the popup)
 *   --expires   ISO date / unix seconds; omit for a lifetime license
 *   --id        custom license id (defaults to a random id)
 *   --private   path to the private JWK (default tools/.secrets/license-private.jwk.json)
 *   --json      print machine-readable JSON instead of text
 *
 * The same `signLicense` function can run in a Cloudflare Worker / Vercel
 * function triggered by your payment provider's webhook for automatic delivery.
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const License = require('../lib/license.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.email || args.help) {
  console.error('usage: node tools/license-sign.mjs --email <address> [--expires <date>] [--id <id>] [--private <path>] [--json]');
  process.exit(args.help ? 0 : 1);
}

const privatePath = path.resolve(root, args.private || 'tools/.secrets/license-private.jwk.json');
let privateJwk;
try {
  privateJwk = JSON.parse(await readFile(privatePath, 'utf8'));
} catch {
  console.error(`Private key not found at ${privatePath}. Run: node tools/license-keygen.mjs`);
  process.exit(1);
}

const expiresAt = args.expires ? (/^\d+$/.test(args.expires) ? Number(args.expires) : args.expires) : null;
const key = await License.signLicense({ email: args.email, expiresAt, id: args.id || null }, privateJwk);

// Self-check against the matching public key so a broken key is never sent out.
const publicJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y };
const check = await License.verifySignedLicense(key, publicJwk);
if (!check.valid) {
  console.error('Self-verification failed:', check.reason);
  process.exit(1);
}

if (args.json) {
  console.log(JSON.stringify({ key, ...check }, null, 2));
} else {
  console.log(`License for ${check.email}${check.expiresAt ? ` (expires ${new Date(check.expiresAt * 1000).toISOString().slice(0, 10)})` : ' (lifetime)'}:\n`);
  console.log(key + '\n');
}
