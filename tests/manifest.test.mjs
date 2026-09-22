import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('manifest is MV3 and versions are consistent', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.name.includes('Plague Doctor'));
  assert.ok(Number(manifest.minimum_chrome_version) >= 111, 'world: "MAIN" needs Chromium 111+');
  // Store / loader limits
  assert.ok(manifest.name.length <= 45, 'name ≤ 45 chars');
  assert.ok(manifest.short_name.length <= 12, 'short_name ≤ 12 chars');
  assert.ok(manifest.description.length <= 132, `description ≤ 132 chars (is ${manifest.description.length})`);
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
});

test('every referenced file exists', () => {
  const files = new Set([
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);
  for (const cs of manifest.content_scripts) for (const f of cs.js) files.add(f);
  // files pulled in by popup.html / background.js
  const popup = readFileSync(path.join(root, 'popup.html'), 'utf8');
  for (const m of popup.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) if (!/^https?:/.test(m[1])) files.add(m[1]);
  const bg = readFileSync(path.join(root, 'background.js'), 'utf8');
  for (const m of bg.matchAll(/importScripts\(([^)]*)\)/g)) for (const f of m[1].split(',')) files.add(f.trim().replace(/['"]/g, ''));

  for (const f of files) assert.ok(existsSync(path.join(root, f)), `missing ${f}`);
});

test('content scripts: page hook runs in MAIN world, bridge in isolated world, both at document_start', () => {
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  const isolated = manifest.content_scripts.find((c) => c.world !== 'MAIN');
  assert.ok(main && main.js.includes('content.js'));
  assert.ok(isolated && isolated.js.includes('bridge.js') && isolated.js.includes('lib/shared.js'));
  for (const cs of manifest.content_scripts) {
    assert.equal(cs.run_at, 'document_start');
    assert.equal(cs.all_frames, true);
    assert.deepEqual(cs.matches, ['<all_urls>']);
  }
  assert.ok(!main.js.some((f) => f.startsWith('lib/')), 'nothing from lib/ may leak into the page world');
});

test('permissions stay minimal and CSP is locked down', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-(inline|eval)/);
  const popup = readFileSync(path.join(root, 'popup.html'), 'utf8');
  assert.doesNotMatch(popup, /<script>[^<]/, 'no inline scripts (blocked by MV3 CSP)');
  assert.doesNotMatch(popup, /\son\w+="/, 'no inline event handlers (blocked by MV3 CSP)');
});

test('the Switch id pattern in content.js matches the shared one', () => {
  const content = readFileSync(path.join(root, 'content.js'), 'utf8');
  const shared = readFileSync(path.join(root, 'lib/shared.js'), 'utf8');
  const pick = (src) => /SWITCH_ID_PATTERN = (\/.*\/i);/.exec(src)[1];
  assert.equal(pick(content), pick(shared));
  const channel = (src) => /(?:CHANNEL|PAGE_CHANNEL) = '([^']+)'/.exec(src)[1];
  assert.equal(channel(content), channel(shared));
});

test('the hosted logo origin (popup.js BRAND.logoUrl) is allowed by the manifest CSP img-src', () => {
  const popupJs = readFileSync(path.join(root, 'popup.js'), 'utf8');
  const m = /logoUrl:\s*'([^']+)'/.exec(popupJs);
  assert.ok(m, 'BRAND.logoUrl present');
  const origin = new URL(m[1]).origin;
  assert.equal(origin, 'https://curedhosting.com');
  const csp = manifest.content_security_policy.extension_pages;
  const imgSrc = /img-src([^;]*)/.exec(csp)[1];
  assert.ok(imgSrc.split(/\s+/).includes(origin), `img-src must include ${origin} (is:${imgSrc})`);
  const styles = readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(styles, /--logo-focus-x/);
  assert.match(styles, /--brand-mark-url: url\("assets\/logo-mark.png"\)/);
});
