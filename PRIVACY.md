# Privacy Policy — Plague Doctor Controller Mapper

_Last updated: 2026-09-22_

Plague Doctor Controller Mapper ("the extension") remaps game-controller buttons
inside your browser. It is designed to work entirely on your device.

## What the extension does with data

- **Controller input** is read through the standard HTML5 Gamepad API only while
  a web page (or the extension popup) asks for it. Button states are re-ordered
  in memory and handed to the page. Nothing is recorded or transmitted.
- **Settings** (your toggles, button profile, keyboard bindings and per-site
  rules) are stored with `chrome.storage.sync`, which your browser may
  synchronise between your own signed-in devices. The extension has no server of
  its own.
- **License keys** for Plague Doctor Pro are verified locally with a public key
  embedded in the extension. The key and its status are stored in
  `chrome.storage` alongside your settings. If the maintainer switches the
  extension to a remote license provider, the key you enter is sent to that
  provider only when you press "Activate" (and periodically to re-validate);
  this document and the store listing will say so explicitly.
- The popup may load the project logo from a GitHub URL. That request carries
  no personal data beyond what any image request contains (your IP address to
  GitHub's CDN).

## What the extension does not do

- No analytics, telemetry, tracking pixels or crash reporting.
- No reading of page content, form data, browsing history or cookies.
- No selling or sharing of data with third parties.

## Permissions explained

| Permission | Why it is needed |
|---|---|
| `storage` | Save your settings and license status. |
| `activeTab`, `scripting` | Let the popup's "Activate on this tab" button install the hook in a tab that was open before the extension was installed. |
| Content scripts on `<all_urls>` | Browser games live on arbitrary domains and the `navigator.getGamepads()` override must be in place before the game starts polling. The script is passive on pages that never use the Gamepad API. |

## Contact

Open an issue at `https://github.com/[YOUR-GITHUB-USERNAME]/[YOUR-REPO]/issues`
or e-mail `[YOUR-CONTACT-EMAIL]`.
