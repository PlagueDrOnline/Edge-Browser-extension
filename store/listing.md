# Store listing copy (Edge Add-ons / Chrome Web Store)

**Name:** Plague Doctor Controller Mapper

**Short description (≤ 132 chars):**
Fix Nintendo Switch A/B & X/Y inversion in browser games. Pro: custom button profiles and gamepad-to-keyboard translation.

**Category:** Games / Accessibility

**Detailed description:**

Playing browser games with a Nintendo Switch Pro Controller or Joy-Cons? Games show "Press A", you press A — and the game cancels. That is because browsers map controllers by button *position*, while Nintendo prints the labels the other way round.

Plague Doctor Controller Mapper fixes it in one click:

• Plague Remap — swaps A ↔ B and X ↔ Y so the label on your pad matches the prompt on screen
• Detects Switch Pro Controller and Joy-Cons automatically (or apply to every controller)
• Pause it per site, check the live tester to see exactly what the game receives
• Works with any game that uses the HTML5 Gamepad API — itch.io, Newgrounds, Unity/Godot/Phaser web exports, emulators…

Plague Doctor Pro (one-time purchase, no subscription):
• Custom 17-button profiles, import/export as JSON
• Gamepad → keyboard translation for games that only listen to the keyboard (buttons, D-pad → arrows, stick → WASD)
• Per-site allow-list for keyboard translation

Privacy: no accounts, no analytics, nothing leaves your browser. Settings sync through your browser profile.

**Single purpose:** Remaps game-controller buttons for web pages.

**Permission justifications:**
- storage — save settings and license status
- activeTab, scripting — "Activate on this tab" for tabs opened before installation
- Content scripts on all sites — games run on arbitrary domains and the getGamepads() hook must exist before the page starts polling

**Assets:** `store/listing-logo-300.png` (300×300). Screenshots: 1280×800 or 640×400, 1–10 images.
