/**
 * Plague Doctor Controller Mapper — page hook.
 *
 * Injected into the page's own JavaScript context (manifest.json →
 * content_scripts[].world = "MAIN", run_at = document_start). Only code that
 * lives in the MAIN world can replace the `navigator.getGamepads` the page
 * calls; an ordinary (isolated-world) content script would only patch its own
 * private copy of `navigator`.
 *
 * Responsibilities
 *   1. Wrap Navigator.prototype.getGamepads so every Gamepad it returns has its
 *      buttons re-ordered through a 17-entry map (A↔B / X↔Y by default).
 *   2. (Pro) Poll the controller and translate presses into synthetic
 *      keyboard events for games that only listen to the keyboard.
 *
 * This file deliberately has NO access to chrome.* APIs. It receives its
 * configuration from bridge.js through window.postMessage and never touches
 * page data. It is self-contained on purpose: nothing from lib/ is loaded here
 * so that no extension globals leak into web pages.
 */
(() => {
  'use strict';

  const HOOK_VERSION = '1.0.0';
  const FLAG = '__plagueDoctorControllerMapper__';
  if (Object.prototype.hasOwnProperty.call(window, FLAG)) return; // already installed in this frame

  // Keep in sync with lib/shared.js
  const CHANNEL = 'plague-doctor-controller-mapper';
  const SWITCH_ID_PATTERN = /vendor:\s*057e|nintendo|\bswitch\b|pro controller|joy-?con/i;
  const STANDARD_BUTTON_COUNT = 17;

  // ---------------------------------------------------------------------------
  // Capture pristine natives before any page script can tamper with them.
  // ---------------------------------------------------------------------------
  const NavigatorProto = typeof Navigator === 'function' ? Navigator.prototype : null;
  const nativeGetGamepads = NavigatorProto && NavigatorProto.getGamepads;
  if (typeof nativeGetGamepads !== 'function') return; // no Gamepad API here (e.g. sandboxed frame)

  const GamepadProto = typeof Gamepad === 'function' ? Gamepad.prototype : null;
  const NativeKeyboardEvent = window.KeyboardEvent;
  const dispatchEvent = EventTarget.prototype.dispatchEvent;
  const addEventListener = EventTarget.prototype.addEventListener;
  const requestAnimationFrame = window.requestAnimationFrame.bind(window);
  const postMessage = window.postMessage.bind(window);
  const now = () => (window.performance ? performance.now() : Date.now());

  Object.defineProperty(window, FLAG, {
    value: Object.freeze({ version: HOOK_VERSION }),
    configurable: false,
    enumerable: false,
    writable: false,
  });

  // ---------------------------------------------------------------------------
  // State (updated by bridge.js via postMessage)
  // ---------------------------------------------------------------------------
  const identityMap = Object.freeze(Array.from({ length: STANDARD_BUTTON_COUNT }, (_, i) => i));

  const state = {
    enabled: false,
    target: 'switch', // 'switch' | 'all'
    map: identityMap, // map[outputIndex] = physicalIndex
    keyboard: { enabled: false, bindings: [], dpadArrows: false, leftStick: 'none', deadzone: 0.5 },
  };

  const stats = {
    calls: 0, // how many times the page called getGamepads()
    lastCallAt: 0,
    remappedIds: new Map(), // gamepad index -> id (remapped on the last call)
  };

  const isIdentity = (map) => map.every((v, i) => v === i);
  const remapActive = () => state.enabled && !isIdentity(state.map);

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    state.enabled = cfg.enabled === true;
    state.target = cfg.target === 'all' ? 'all' : 'switch';

    const map = Array.isArray(cfg.map) ? cfg.map : [];
    state.map = Object.freeze(
      identityMap.map((def, i) => {
        const v = map[i];
        return Number.isInteger(v) && v >= 0 && v < STANDARD_BUTTON_COUNT ? v : def;
      })
    );

    const kb = cfg.keyboard && typeof cfg.keyboard === 'object' ? cfg.keyboard : {};
    state.keyboard = {
      enabled: kb.enabled === true,
      dpadArrows: kb.dpadArrows === true,
      leftStick: kb.leftStick === 'arrows' || kb.leftStick === 'wasd' ? kb.leftStick : 'none',
      deadzone: typeof kb.deadzone === 'number' ? Math.min(0.95, Math.max(0.1, kb.deadzone)) : 0.5,
      bindings: Array.isArray(kb.bindings)
        ? kb.bindings
            .filter((b) => b && Number.isInteger(b.button) && typeof b.code === 'string' && b.code)
            .map((b) => ({
              button: b.button,
              code: b.code,
              key: typeof b.key === 'string' && b.key ? b.key : b.code,
              keyCode: Number.isInteger(b.keyCode) ? b.keyCode : 0,
            }))
        : [],
    };

    wrapCache.clear();
    syncKeyboardLoop();
  }

  // ---------------------------------------------------------------------------
  // Gamepad remapping
  // ---------------------------------------------------------------------------
  const wrapCache = new Map(); // gamepad index -> { id, timestamp, connected, map, wrapped }

  function shouldRemap(pad) {
    return state.target === 'all' || SWITCH_ID_PATTERN.test(pad.id);
  }

  /**
   * Returns a Gamepad-shaped snapshot whose `buttons` array is re-ordered
   * through `state.map`. Native Gamepad objects are read-only, so a new object
   * is created; it inherits from Gamepad.prototype (instanceof still works) and
   * re-uses the native GamepadButton instances, just in a different order.
   */
  function wrapGamepad(pad) {
    if (!pad || !remapActive() || !shouldRemap(pad)) return pad;

    const cached = wrapCache.get(pad.index);
    if (
      cached &&
      cached.map === state.map &&
      cached.id === pad.id &&
      cached.timestamp === pad.timestamp &&
      cached.connected === pad.connected
    ) {
      return cached.wrapped;
    }

    const source = pad.buttons;
    const count = source.length;
    const buttons = new Array(count);
    for (let out = 0; out < count; out++) {
      const physical = out < state.map.length ? state.map[out] : out;
      buttons[out] = physical < count ? source[physical] : source[out];
    }

    const wrapped = GamepadProto ? Object.create(GamepadProto) : {};
    const props = {
      id: pad.id,
      index: pad.index,
      connected: pad.connected,
      timestamp: pad.timestamp,
      mapping: pad.mapping,
      axes: pad.axes,
      buttons: Object.freeze(buttons),
    };
    // Optional members (haptics etc.) are forwarded untouched when the browser exposes them.
    for (const extra of ['vibrationActuator', 'hapticActuators', 'pose', 'hand', 'displayId', 'touchEvents']) {
      if (extra in pad) {
        try { props[extra] = pad[extra]; } catch (_) { /* ignore */ }
      }
    }
    for (const key of Object.keys(props)) {
      Object.defineProperty(wrapped, key, { value: props[key], enumerable: true, configurable: true });
    }

    wrapCache.set(pad.index, {
      id: pad.id,
      timestamp: pad.timestamp,
      connected: pad.connected,
      map: state.map,
      wrapped,
    });
    return wrapped;
  }

  function patchedGetGamepads() {
    // `this` is forwarded so mis-use throws exactly like the native function would.
    const pads = nativeGetGamepads.call(this);
    stats.calls++;
    stats.lastCallAt = now();
    if (!pads || !remapActive()) {
      if (stats.remappedIds.size) stats.remappedIds.clear();
      return pads;
    }

    let changed = false;
    const out = new Array(pads.length);
    stats.remappedIds.clear();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      const wrapped = wrapGamepad(pad);
      if (wrapped !== pad) {
        changed = true;
        stats.remappedIds.set(pad.index, pad.id);
      }
      out[i] = wrapped;
    }
    return changed ? out : pads;
  }

  function installOverride() {
    try { Object.defineProperty(patchedGetGamepads, 'name', { value: 'getGamepads' }); } catch (_) { /* ignore */ }
    Object.defineProperty(NavigatorProto, 'getGamepads', {
      value: patchedGetGamepads,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    // Legacy prefixed alias (very old builds / shims).
    if (typeof NavigatorProto.webkitGetGamepads === 'function') {
      Object.defineProperty(NavigatorProto, 'webkitGetGamepads', {
        value: patchedGetGamepads, writable: true, configurable: true, enumerable: true,
      });
    }

    // gamepadconnected / gamepaddisconnected events also carry a Gamepad —
    // keep them consistent with what getGamepads() returns.
    if (typeof GamepadEvent === 'function') {
      const desc = Object.getOwnPropertyDescriptor(GamepadEvent.prototype, 'gamepad');
      if (desc && typeof desc.get === 'function' && desc.configurable) {
        const nativeGetter = desc.get;
        Object.defineProperty(GamepadEvent.prototype, 'gamepad', {
          configurable: true,
          enumerable: true,
          get() { return wrapGamepad(nativeGetter.call(this)); },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pro: gamepad → keyboard translation
  // ---------------------------------------------------------------------------
  const KEY = (key, code, keyCode) => Object.freeze({ key, code, keyCode });
  const KEYS = Object.freeze({
    ArrowUp: KEY('ArrowUp', 'ArrowUp', 38),
    ArrowDown: KEY('ArrowDown', 'ArrowDown', 40),
    ArrowLeft: KEY('ArrowLeft', 'ArrowLeft', 37),
    ArrowRight: KEY('ArrowRight', 'ArrowRight', 39),
    KeyW: KEY('w', 'KeyW', 87),
    KeyA: KEY('a', 'KeyA', 65),
    KeyS: KEY('s', 'KeyS', 83),
    KeyD: KEY('d', 'KeyD', 68),
  });
  const STICK_SETS = Object.freeze({
    arrows: { up: KEYS.ArrowUp, down: KEYS.ArrowDown, left: KEYS.ArrowLeft, right: KEYS.ArrowRight },
    wasd: { up: KEYS.KeyW, down: KEYS.KeyS, left: KEYS.KeyA, right: KEYS.KeyD },
  });
  const DPAD = Object.freeze([
    [12, KEYS.ArrowUp], [13, KEYS.ArrowDown], [14, KEYS.ArrowLeft], [15, KEYS.ArrowRight],
  ]);

  const heldKeys = new Map(); // code -> key descriptor currently "down"
  let loopHandle = 0;

  function keyboardWanted() {
    const kb = state.keyboard;
    return kb.enabled && (kb.bindings.length > 0 || kb.dpadArrows || kb.leftStick !== 'none');
  }

  function syncKeyboardLoop() {
    if (keyboardWanted()) {
      if (!loopHandle) loopHandle = requestAnimationFrame(keyboardTick);
    } else {
      releaseAllKeys();
    }
  }

  function isEditable(el) {
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  function eventTarget() {
    const el = document.activeElement;
    if (el && el !== document.body && el !== document.documentElement) return el; // e.g. focused <canvas tabindex>
    return document.body || document.documentElement || document;
  }

  function fireKey(type, desc) {
    const target = eventTarget();
    if (!target) return;
    const init = {
      key: desc.key,
      code: desc.code,
      keyCode: desc.keyCode,
      which: desc.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      repeat: false,
      view: window,
    };
    try {
      dispatchEvent.call(target, new NativeKeyboardEvent(type, init));
      // Browsers also emit a legacy keypress for printable characters — some
      // older games rely on it.
      if (type === 'keydown' && desc.key.length === 1) {
        const charCode = desc.key.charCodeAt(0);
        dispatchEvent.call(target, new NativeKeyboardEvent('keypress', { ...init, charCode, keyCode: charCode, which: charCode }));
      }
    } catch (_) { /* never let a synthetic event break the page */ }
  }

  function releaseAllKeys() {
    if (!heldKeys.size) return;
    for (const [code, desc] of heldKeys) {
      heldKeys.delete(code);
      fireKey('keyup', desc);
    }
  }

  function pressedValue(button) {
    return !!button && (button.pressed || button.value > 0.5);
  }

  function collectDesiredKeys(pads, desired) {
    const kb = state.keyboard;
    for (let i = 0; i < pads.length; i++) {
      const raw = pads[i];
      if (!raw || !raw.connected) continue;
      // Bindings are expressed in the *remapped* layout — the same labels the game sees.
      const pad = wrapGamepad(raw);
      const buttons = pad.buttons;

      for (const b of kb.bindings) {
        if (pressedValue(buttons[b.button])) desired.set(b.code, b);
      }
      if (kb.dpadArrows) {
        for (const [index, key] of DPAD) {
          if (pressedValue(buttons[index])) desired.set(key.code, key);
        }
      }
      if (kb.leftStick !== 'none' && pad.axes && pad.axes.length >= 2) {
        const set = STICK_SETS[kb.leftStick];
        const x = pad.axes[0];
        const y = pad.axes[1];
        const dz = kb.deadzone;
        if (y <= -dz) desired.set(set.up.code, set.up);
        else if (y >= dz) desired.set(set.down.code, set.down);
        if (x <= -dz) desired.set(set.left.code, set.left);
        else if (x >= dz) desired.set(set.right.code, set.right);
      }
    }
  }

  function keyboardTick() {
    loopHandle = 0;
    if (!keyboardWanted()) { releaseAllKeys(); return; }
    loopHandle = requestAnimationFrame(keyboardTick);

    // Never type into text fields / unfocused documents; release anything held.
    if (document.hidden || !document.hasFocus() || isEditable(document.activeElement)) {
      releaseAllKeys();
      return;
    }

    let pads = null;
    try { pads = nativeGetGamepads.call(navigator); } catch (_) { return; }
    if (!pads) { releaseAllKeys(); return; }

    const desired = new Map();
    collectDesiredKeys(pads, desired);

    for (const [code, desc] of heldKeys) {
      if (!desired.has(code)) { heldKeys.delete(code); fireKey('keyup', desc); }
    }
    for (const [code, desc] of desired) {
      if (!heldKeys.has(code)) { heldKeys.set(code, desc); fireKey('keydown', desc); }
    }
  }

  addEventListener.call(window, 'blur', releaseAllKeys, true);
  addEventListener.call(document, 'visibilitychange', () => { if (document.hidden) releaseAllKeys(); }, true);

  // ---------------------------------------------------------------------------
  // Messaging with bridge.js (isolated world)
  // ---------------------------------------------------------------------------
  function send(type, payload) {
    // Same-window message; '*' is required because sandboxed/opaque origins
    // cannot be addressed by name. Nothing sensitive travels over this channel.
    try { postMessage({ channel: CHANNEL, dir: 'to-extension', type, ...payload }, '*'); } catch (_) { /* ignore */ }
  }

  function statusSnapshot() {
    return {
      version: HOOK_VERSION,
      remapActive: remapActive(),
      keyboardActive: !!loopHandle,
      calls: stats.calls,
      lastCallAgoMs: stats.lastCallAt ? Math.round(now() - stats.lastCallAt) : null,
      remapped: Array.from(stats.remappedIds, ([index, id]) => ({ index, id })),
    };
  }

  addEventListener.call(window, 'message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.channel !== CHANNEL || data.dir !== 'to-page') return;
    switch (data.type) {
      case 'config':
        applyConfig(data.config);
        break;
      case 'status-request':
        send('status', { requestId: data.requestId, status: statusSnapshot() });
        break;
      default:
        break;
    }
  }, false);

  installOverride();
  send('ready', { version: HOOK_VERSION });
})();
