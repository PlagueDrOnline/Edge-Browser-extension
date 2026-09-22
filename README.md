<p align="center">
  <img src="store/listing-logo-300.png" width="128" alt="Plague Doctor Controller Mapper">
</p>

<h1 align="center">Plague Doctor Controller Mapper</h1>

<p align="center">
  Microsoft Edge / Chrome extension (Manifest V3) that fixes the Nintendo Switch
  <b>A/B &amp; X/Y inversion</b> in browser games — with optional Pro profiles and
  gamepad → keyboard translation.
</p>

---

## Why

The W3C "standard gamepad" layout is defined by **physical position**:
`buttons[0]` is the *bottom* face button, `buttons[1]` the *right* one, and so on.
Chromium maps a Switch Pro Controller / Joy-Cons that way, so pressing the button
**labelled A** on a Switch pad (physically on the right) arrives in the game as
`buttons[1]` — which every game draws as **B**. Games say "press A", you press A,
the game cancels.

Plague Remap swaps `0 ↔ 1` and `2 ↔ 3` for detected Nintendo hardware so the
label on your controller matches the prompt on screen.

## Features

| Free | Plague Doctor Pro (one-time purchase) |
|---|---|
| ✅ A ↔ B and X ↔ Y swap, individually toggleable | ✅ Custom 17-button profile matrix |
| ✅ Auto-detects Switch Pro Controller & Joy-Cons (vendor `057e`), or apply to all pads | ✅ Import / export / share profiles as JSON |
| ✅ Per-site pause | ✅ Gamepad → keyboard translation (buttons, D-pad → arrows, left stick → WASD/arrows) |
| ✅ Live tester in the popup ("Physical" vs "Game sees") | ✅ Per-site allow-list for keyboard translation |
| ✅ Page diagnostics (is the hook installed? is the game polling?) | ✅ Offline license keys — no account, no subscription |

## Project structure

```
Edge-Browser-extension/
├── manifest.json            MV3 manifest (Edge & Chrome)
├── background.js            Service worker: settings bootstrap, badge, Pro license, on-demand injection
├── content.js               PAGE HOOK — runs in the page's MAIN world, wraps navigator.getGamepads()
├── bridge.js                Isolated-world content script: storage ⇄ page hook, popup diagnostics
├── popup.html               Popup UI (branding, Plague Remap toggle, Pro banner, Pro features)
├── popup.js                 Popup logic, live tester, license activation
├── styles.css               Dark Plague Doctor theme (crimson + neon teal)
├── lib/
│   ├── shared.js            Settings schema, normalisation, effective-config resolver, constants
│   └── license.js           Offline ECDSA license keys (sign / verify) — WebCrypto, runs in SW & Node
├── icons/                   16 / 32 / 48 / 128 px toolbar icons
├── assets/
│   ├── logo.png             Popup header badge (bundled fallback for the hosted logo)
│   ├── logo-mark.png        Transparent mark for watermarks
│   └── logo-master.png      Source crop used to regenerate icons
├── store/
│   └── listing-logo-300.png Store listing logo (Edge Add-ons / Chrome Web Store)
├── tools/
│   ├── license-keygen.mjs   Generate your signing key pair (once)
│   ├── license-sign.mjs     Mint a Pro key for a customer
│   ├── package.sh           Build the store zip into dist/
│   └── make-icons.sh        Regenerate icons from the logo (ImageMagick)
├── tests/                   `npm test` — unit tests + vm/jsdom harnesses for content.js, background.js, popup.js
├── dev/                     Popup preview in a normal tab with a fake chrome API (dev/preview.html)
├── PRIVACY.md               Privacy policy for the store listing
└── plague_logo.png          Original artwork
```

## Install (unpacked)

1. Clone / download this repository.
2. Edge: open `edge://extensions`, enable **Developer mode**, click **Load unpacked**
   and select the repository folder (the one containing `manifest.json`).
   Chrome: `chrome://extensions` → Developer mode → Load unpacked.
3. Reload any game tab that was already open (or use **Activate on this tab** in the popup).
4. Press a button on your controller — the browser only exposes gamepads after a
   button press — and check the **Live test** card.

Requires Chromium 111+ (the manifest declares `minimum_chrome_version`).

## How it works

```
 popup.html/js  ──chrome.storage.sync──▶  bridge.js (isolated world, document_start)
      │                                        │  computeEffectiveConfig(settings, license, site)
      │ tabs.sendMessage (diagnostics)         │  window.postMessage
      ▼                                        ▼
 background.js ◀─runtime messages─┐   content.js (MAIN world, document_start)
  license / badge / injection     │     Navigator.prototype.getGamepads = wrapped
                                  │     GamepadEvent.prototype.gamepad  = wrapped
                                  └──── game code: navigator.getGamepads()[0].buttons[0] ✔
```

* **Why two content scripts?** An ordinary content script lives in an isolated
  world: patching `navigator.getGamepads` there only changes the extension's
  private copy. MV3's `"world": "MAIN"` runs `content.js` in the page's own
  context *before any page script* and without being subject to the page's CSP.
  Main-world scripts cannot use `chrome.*`, so `bridge.js` (isolated world)
  reads storage and hands the resolved config over `window.postMessage`.
* **What the game receives** is a `Gamepad`-shaped snapshot that inherits from
  `Gamepad.prototype` (`instanceof` still works), reuses the native
  `GamepadButton` objects in the new order, forwards `axes`, `timestamp`,
  `mapping`, `vibrationActuator`, and is cached per `timestamp` so identity is
  stable while nothing changed. Non-Switch pads are passed through untouched
  unless "All controllers" is selected. If the effective map is the identity
  map the native array is returned as-is.
* **Keyboard translation (Pro)** polls with `requestAnimationFrame` only when
  enabled for the site, computes the set of keys that should be held, and emits
  `keydown` / `keyup` (plus legacy `keypress` for printable keys) on edges.
  Focus loss, hidden tabs and focused text fields release every key; nothing is
  typed into inputs. Synthetic events have `isTrusted === false` — the vast
  majority of games do not check it.
* **Storage layout** — `chrome.storage.sync`: `pdcm.settings`, `pdcm.license`
  (roams to your other devices); `chrome.storage.local`: `pdcm.licenseStatus`
  (per-device verification cache written by the service worker).

## Branding

* **Logo:** the popup header loads `https://curedhosting.com/plague_logo.png`
  (`BRAND.logoUrl` in `popup.js`) and shows the bundled `assets/logo.png` badge
  until it arrives — or permanently if the server is unreachable. Because the
  artwork is 1024×1024 with the character on the left, `styles.css` crops it to
  the same circular badge with `--logo-focus-x / --logo-focus-y / --logo-zoom`;
  the bundled badge is pre-rendered with identical numbers by
  `tools/make-icons.sh`, so the swap is seamless. Changing the host? Update
  `BRAND.logoUrl` **and** `img-src` in the manifest CSP (a test enforces this).
* Watermarks (header, Pro card) use the transparent `assets/logo-mark.png` via
  `--brand-mark-url`.
* Colours live in `:root` of `styles.css` (`--pd-crimson`, `--pd-teal`, …).
* Regenerate icons / badge after changing the artwork: `npm run icons` (needs ImageMagick).

## Monetisation — Plague Doctor Pro

Pro features are gated by `computeEffectiveConfig()` in `lib/shared.js`; the UI
and the page hook both derive from it, so a locked feature is inert even if its
settings exist. The popup's Pro card contains the price, a **Get Pro** button and
a license-key form. Fill in `BRAND.checkoutUrl` / `BRAND.priceLabel` in `popup.js`.

### Option A (default) — offline signed keys, zero infrastructure

```bash
npm install                          # dev only (jsdom for tests)
node tools/license-keygen.mjs        # once → tools/.secrets/ (git-ignored) + prints the public JWK
# paste the printed publicKeyJwk into background.js → LICENSE_CONFIG.publicKeyJwk
node tools/license-sign.mjs --email customer@example.com            # lifetime key
node tools/license-sign.mjs --email customer@example.com --expires 2027-12-31
```

Keys look like `PDCM.<payload>.<signature>` (ECDSA P-256, verified with
WebCrypto in the service worker). Deliver them manually after a payment, or
automate: a Gumroad / Lemon Squeezy / Stripe webhook → small serverless
function that calls `signLicense()` from `lib/license.js` (it runs unchanged on
Cloudflare Workers / Vercel) and e-mails the key. **Never ship or commit the
private key.** Rotating it invalidates all issued keys.

### Option B — Gumroad license keys

Set `LICENSE_CONFIG.provider = 'gumroad'` and `gumroad.productId` in
`background.js`, then add `"host_permissions": ["https://api.gumroad.com/*"]`
and `https://api.gumroad.com` to `connect-src` in the manifest CSP. Refunded or
charged-back purchases are treated as revoked on the next re-validation
(every 7 days, with offline grace).

### Option C — your own endpoint

Set `provider = 'remote'` and `remote.url`. The worker POSTs
`{ key, extension, version }` and expects `{ valid, email, plan, expiresAt, reason }`.
Add the origin to `host_permissions` (if it lacks CORS) and to `connect-src`.

## Development

```bash
npm test                 # 37 tests: shared lib, license crypto, manifest, content.js (vm), background.js (vm), popup (jsdom)
python3 -m http.server   # then open http://localhost:8000/dev/preview.html for a live popup preview
npm run package          # → dist/plague-doctor-controller-mapper-<version>.zip
```

`dev/` and `tests/` are never packaged.

## Store submission (Edge Add-ons / Chrome Web Store)

1. Bump `version` in `manifest.json` and `package.json`, run `npm test`, then `npm run package`.
2. [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) → new extension → upload the zip.
3. Listing assets: `store/listing-logo-300.png`, 1–10 screenshots (1280×800 or 640×400), a short description
   (≤ 132 chars, e.g. *"Fix Switch A/B & X/Y inversion in browser games. Pro: custom profiles and gamepad-to-keyboard."*).
4. Privacy: link to `PRIVACY.md` (host it on GitHub Pages or paste the text) and declare **no data collection**.
5. Permission justifications (copy from `PRIVACY.md`): `storage`, `activeTab`, `scripting`, and content scripts on
   `<all_urls>` because games live on arbitrary domains and the hook must exist before the page polls the Gamepad API.
6. Single-purpose statement: *"Remaps game-controller buttons for web pages."*

## Limitations

* Gamepads only become visible after a button press while the page is focused (browser privacy rule).
* Games that cache `navigator.getGamepads` **before** the hook runs are not affected — only possible for tabs that
  were open before installation; reload them.
* Synthetic keyboard events are `isTrusted: false`; a few engines ignore untrusted events.
* Cross-origin `<iframe>` games need the `gamepad` Permissions-Policy from the embedding page (a browser rule,
  independent of this extension).
* Firefox: MV3 `world: "MAIN"` is supported (128+), but `background.service_worker` would have to be replaced by
  `background.scripts`.

## License

Source is provided for the Plague Doctor project; choose and add a `LICENSE` file before publishing the repository
(`package.json` currently says `UNLICENSED`).
