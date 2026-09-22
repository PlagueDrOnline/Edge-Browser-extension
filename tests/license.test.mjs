import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const License = require('../lib/license.js');

const pair = await License.generateKeyPair();
const publicJwk = { kty: pair.publicJwk.kty, crv: pair.publicJwk.crv, x: pair.publicJwk.x, y: pair.publicJwk.y };

test('sign → verify round trip', async () => {
  const key = await License.signLicense({ email: 'Buyer@Example.com' }, pair.privateJwk);
  assert.match(key, /^PDCM\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const r = await License.verifySignedLicense(key, publicJwk);
  assert.equal(r.valid, true);
  assert.equal(r.reason, 'ok');
  assert.equal(r.email, 'buyer@example.com');
  assert.equal(r.plan, 'pro');
  assert.equal(r.expiresAt, null);
  assert.match(r.licenseId, /^lic_/);
});

test('whitespace / line breaks in a pasted key are tolerated', async () => {
  const key = await License.signLicense({ email: 'a@b.c' }, pair.privateJwk);
  const messy = `  ${key.slice(0, 20)}\n${key.slice(20, 60)} \t${key.slice(60)}  `;
  const r = await License.verifySignedLicense(messy, publicJwk);
  assert.equal(r.valid, true);
});

test('tampered payload fails signature check', async () => {
  const key = await License.signLicense({ email: 'a@b.c' }, pair.privateJwk);
  const [prefix, payload, sig] = key.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString());
  json.email = 'mallory@evil.example';
  const forged = `${prefix}.${Buffer.from(JSON.stringify(json)).toString('base64url')}.${sig}`;
  const r = await License.verifySignedLicense(forged, publicJwk);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'bad-signature');
});

test('key signed by a different private key is rejected', async () => {
  const other = await License.generateKeyPair();
  const key = await License.signLicense({ email: 'a@b.c' }, other.privateJwk);
  const r = await License.verifySignedLicense(key, publicJwk);
  assert.equal(r.reason, 'bad-signature');
});

test('expiry is enforced', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const expired = await License.signLicense({ email: 'a@b.c', expiresAt: past }, pair.privateJwk);
  assert.equal((await License.verifySignedLicense(expired, publicJwk)).reason, 'expired');

  const future = await License.signLicense({ email: 'a@b.c', expiresAt: '2999-01-01' }, pair.privateJwk);
  const r = await License.verifySignedLicense(future, publicJwk);
  assert.equal(r.valid, true);
  assert.ok(r.expiresAt > Date.now() / 1000);
});

test('malformed input and missing configuration are reported, never thrown', async () => {
  assert.equal((await License.verifySignedLicense('', publicJwk)).reason, 'malformed');
  assert.equal((await License.verifySignedLicense('PDCM.notbase64!!.zzz', publicJwk)).reason, 'malformed');
  assert.equal((await License.verifySignedLicense('ABCD.e30.e30', publicJwk)).reason, 'malformed');
  assert.equal((await License.verifySignedLicense('PDCM.e30.e30', publicJwk)).reason, 'bad-signature');
  const key = await License.signLicense({ email: 'a@b.c' }, pair.privateJwk);
  assert.equal((await License.verifySignedLicense(key, null)).reason, 'not-configured');
});

test('unsupported plan / version is rejected even when correctly signed', async () => {
  const key = await License.signLicense({ email: 'a@b.c', plan: 'enterprise' }, pair.privateJwk);
  assert.equal((await License.verifySignedLicense(key, publicJwk)).reason, 'unsupported');
});
