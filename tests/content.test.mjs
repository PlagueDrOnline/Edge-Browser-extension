/**
 * Runs content.js (the MAIN-world page hook) inside a vm context with a small
 * fake DOM / Gamepad API and checks the observable behaviour a web game sees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'content.js'), 'utf8');

const SWITCH_ID = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';
const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const SWAP_MAP = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function createPage() {
  const rafQueue = [];
  const outbox = []; // messages content.js posts to the bridge
  const dispatched = []; // keyboard events dispatched into the "page"

  class EventTarget {
    addEventListener(type, fn) {
      (this.__l ||= new Map());
      if (!this.__l.has(type)) this.__l.set(type, []);
      this.__l.get(type).push(fn);
    }
    dispatchEvent(event) {
      event.target = this;
      for (const fn of (this.__l && this.__l.get(event.type)) || []) fn.call(this, event);
      return true;
    }
  }
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  class KeyboardEvent extends Event {}
  class MessageEvent extends Event {}
  class GamepadEvent extends Event {
    constructor(type, init) { super(type); this.__pad = init.gamepad; }
    get gamepad() { return this.__pad; }
  }
  class Gamepad {}
  class GamepadButton {
    constructor(pressed = false, value = pressed ? 1 : 0) { this.pressed = pressed; this.touched = pressed; this.value = value; }
  }
  class Navigator {}

  const pads = [null, null, null, null];
  let timestamp = 1;
  Navigator.prototype.getGamepads = function getGamepads() {
    if (!(this instanceof Navigator)) throw new TypeError('Illegal invocation');
    return pads.slice();
  };

  const body = new EventTarget();
  body.tagName = 'BODY';
  const document = new EventTarget();
  Object.assign(document, { body, documentElement: body, activeElement: body, hidden: false, hasFocus: () => true });
  for (const type of ['keydown', 'keyup', 'keypress']) body.addEventListener(type, (e) => dispatched.push(e));

  const window = new EventTarget();
  Object.assign(window, {
    window,
    document,
    EventTarget, Event, KeyboardEvent, MessageEvent, GamepadEvent, Gamepad, GamepadButton, Navigator,
    navigator: new Navigator(),
    requestAnimationFrame: (cb) => rafQueue.push(cb),
    cancelAnimationFrame: () => {},
    postMessage: (data) => outbox.push(data),
    Object, Array, Map, Number, Date, TypeError, Math, JSON,
    console,
  });
  vm.createContext(window);
  // Inside the context the global identifier `window` resolves to V8's global
  // proxy, which is a different object from the sandbox as seen from out here.
  const inner = vm.runInContext('globalThis', window);

  const api = {
    window,
    document,
    outbox,
    dispatched,
    run() { vm.runInContext(source, window, { filename: 'content.js' }); },
    /** Simulate bridge.js → page */
    sendConfig(config) {
      window.dispatchEvent(new MessageEvent('message', {
        source: inner,
        data: { channel: 'plague-doctor-controller-mapper', dir: 'to-page', type: 'config', config },
      }));
    },
    requestStatus(requestId = 1) {
      window.dispatchEvent(new MessageEvent('message', {
        source: inner,
        data: { channel: 'plague-doctor-controller-mapper', dir: 'to-page', type: 'status-request', requestId },
      }));
    },
    addPad(index, id, { buttons = 17, axes = [0, 0, 0, 0] } = {}) {
      const pad = Object.create(Gamepad.prototype);
      Object.assign(pad, {
        id, index, connected: true, mapping: 'standard', timestamp: timestamp++,
        axes, buttons: Array.from({ length: buttons }, () => new GamepadButton()),
      });
      pads[index] = pad;
      return pad;
    },
    press(pad, i, value = 1) { pad.buttons[i] = new GamepadButton(true, value); pad.timestamp = timestamp++; },
    release(pad, i) { pad.buttons[i] = new GamepadButton(false); pad.timestamp = timestamp++; },
    setAxes(pad, axes) { pad.axes = axes; pad.timestamp = timestamp++; },
    frame() { const q = rafQueue.splice(0); for (const cb of q) cb(); },
    pendingFrames: () => rafQueue.length,
    keys: (type) => dispatched.filter((e) => e.type === type).map((e) => e.code),
    getGamepads: () => window.navigator.getGamepads(),
  };
  return api;
}

test('installs once, announces itself and passes gamepads through until configured', () => {
  const page = createPage();
  page.run();
  assert.equal(page.outbox[0].type, 'ready');
  assert.equal(page.window.navigator.getGamepads.name, 'getGamepads');

  const patched = page.window.Navigator.prototype.getGamepads;
  page.run(); // second injection must be a no-op
  assert.equal(page.window.Navigator.prototype.getGamepads, patched);

  const sw = page.addPad(0, SWITCH_ID);
  page.press(sw, 1);
  const pads = page.getGamepads();
  assert.equal(pads[0], sw, 'no config yet → native object returned untouched');
  assert.equal(pads[0].buttons[1].pressed, true);
});

test('swaps A/B and X/Y for Switch pads only, keeps everything else intact', () => {
  const page = createPage();
  page.run();
  const sw = page.addPad(0, SWITCH_ID);
  const xb = page.addPad(1, XBOX_ID);
  page.sendConfig({ enabled: true, target: 'switch', map: SWAP_MAP });

  page.press(sw, 1); // physical "A" on a Switch pad = standard index 1
  page.press(sw, 3); // physical "X" on a Switch pad = standard index 3
  page.press(sw, 9); // "+"
  page.press(xb, 1); // Xbox B

  const pads = page.getGamepads();
  const s = pads[0];
  assert.notEqual(s, sw, 'Switch pad is wrapped');
  assert.ok(s instanceof page.window.Gamepad, 'wrapper still passes instanceof Gamepad');
  assert.equal(s.buttons[0].pressed, true, 'game now sees A (index 0) when the Switch A is pressed');
  assert.equal(s.buttons[1].pressed, false);
  assert.equal(s.buttons[2].pressed, true, 'game sees X (index 2) when the Switch X is pressed');
  assert.equal(s.buttons[3].pressed, false);
  assert.equal(s.buttons[9].pressed, true, 'non-face buttons untouched');
  assert.equal(s.buttons.length, 17);
  assert.equal(s.buttons[0], sw.buttons[1], 'native GamepadButton instances are reused');
  assert.equal(s.axes, sw.axes);
  assert.equal(s.id, SWITCH_ID);
  assert.equal(s.index, 0);
  assert.equal(s.mapping, 'standard');
  assert.equal(s.timestamp, sw.timestamp);
  assert.ok(Object.isFrozen(s.buttons));

  assert.equal(pads[1], xb, 'Xbox pad is passed through untouched');
  assert.equal(pads[1].buttons[1].pressed, true);
  assert.equal(pads[2], null);
  assert.equal(pads.length, 4);

  // Same snapshot returned while nothing changed, fresh one after a change.
  assert.equal(page.getGamepads()[0], s);
  page.release(sw, 1);
  const again = page.getGamepads()[0];
  assert.notEqual(again, s);
  assert.equal(again.buttons[0].pressed, false);
});

test('"all controllers" target and partial maps', () => {
  const page = createPage();
  page.run();
  const xb = page.addPad(0, XBOX_ID);
  page.sendConfig({ enabled: true, target: 'all', map: [1, 0] }); // short map → rest identity
  page.press(xb, 1);
  page.press(xb, 3);
  const p = page.getGamepads()[0];
  assert.notEqual(p, xb);
  assert.equal(p.buttons[0].pressed, true);
  assert.equal(p.buttons[3].pressed, true, 'unspecified entries keep their position');

  page.sendConfig({ enabled: true, target: 'all', map: [0, 1, 2, 3] }); // identity → nothing to do
  assert.equal(page.getGamepads()[0], xb);

  page.sendConfig({ enabled: false, target: 'all', map: SWAP_MAP });
  assert.equal(page.getGamepads()[0], xb);
});

test('pads with fewer buttons than the map never read out of range', () => {
  const page = createPage();
  page.run();
  const joycon = page.addPad(0, 'Joy-Con (R) (Vendor: 057e Product: 2007)', { buttons: 12 });
  page.sendConfig({ enabled: true, target: 'switch', map: [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 16, 15, 14, 13, 12] });
  page.press(joycon, 0);
  const p = page.getGamepads()[0];
  assert.equal(p.buttons.length, 12);
  assert.equal(p.buttons[1].pressed, true);
  assert.ok(p.buttons.every(Boolean));
});

test('GamepadEvent.gamepad is remapped consistently', () => {
  const page = createPage();
  page.run();
  const sw = page.addPad(0, SWITCH_ID);
  page.sendConfig({ enabled: true, target: 'switch', map: SWAP_MAP });
  page.press(sw, 1);
  const ev = new page.window.GamepadEvent('gamepadconnected', { gamepad: sw });
  assert.equal(ev.gamepad.buttons[0].pressed, true);
  assert.equal(ev.gamepad, page.getGamepads()[0], 'same cached snapshot as getGamepads()');
});

test('status-request answers with diagnostics', () => {
  const page = createPage();
  page.run();
  const sw = page.addPad(0, SWITCH_ID);
  page.sendConfig({ enabled: true, target: 'switch', map: SWAP_MAP });
  page.getGamepads();
  page.getGamepads();
  page.requestStatus(42);
  const reply = page.outbox.find((m) => m.type === 'status');
  assert.equal(reply.requestId, 42);
  assert.equal(reply.status.calls, 2);
  assert.equal(reply.status.remapActive, true);
  assert.deepEqual(JSON.parse(JSON.stringify(reply.status.remapped)), [{ index: 0, id: sw.id }]); // cross-realm objects
  assert.equal(reply.status.keyboardActive, false);
});

test('keyboard translation: bindings, d-pad, stick, edge detection and focus loss', () => {
  const page = createPage();
  page.run();
  const sw = page.addPad(0, SWITCH_ID);
  assert.equal(page.pendingFrames(), 0, 'no polling loop unless keyboard mode is on');

  page.sendConfig({
    enabled: true,
    target: 'switch',
    map: SWAP_MAP,
    keyboard: {
      enabled: true,
      dpadArrows: true,
      leftStick: 'wasd',
      deadzone: 0.5,
      bindings: [{ button: 0, code: 'Space', key: ' ', keyCode: 32 }],
    },
  });
  assert.equal(page.pendingFrames(), 1, 'loop scheduled');

  page.frame();
  assert.deepEqual(page.keys('keydown'), [], 'nothing pressed yet');

  // Binding is expressed in the remapped layout: "A" (output 0) is fed by physical index 1 on a Switch pad.
  page.press(sw, 1);
  page.frame();
  assert.deepEqual(page.keys('keydown'), ['Space']);
  assert.deepEqual(page.keys('keypress'), ['Space'], 'printable keys also get a legacy keypress');
  const down = page.dispatched.find((e) => e.type === 'keydown');
  assert.equal(down.keyCode, 32);
  assert.equal(down.key, ' ');
  assert.equal(down.bubbles, true);

  page.frame(); // still held → no repeat events
  assert.equal(page.keys('keydown').length, 1);

  page.release(sw, 1);
  page.frame();
  assert.deepEqual(page.keys('keyup'), ['Space']);

  // D-pad → arrows, left stick → WASD (with deadzone)
  page.press(sw, 14); // D-Left
  page.setAxes(sw, [0.2, -0.9, 0, 0]); // slight x (inside deadzone), strong up
  page.frame();
  assert.deepEqual(page.keys('keydown').slice(1).sort(), ['ArrowLeft', 'KeyW']);

  // Losing focus releases everything that is held.
  page.document.hasFocus = () => false;
  page.frame();
  assert.deepEqual(page.keys('keyup').slice(1).sort(), ['ArrowLeft', 'KeyW']);
  page.document.hasFocus = () => true;

  // Typing in a text field is never interrupted.
  page.document.activeElement = { tagName: 'INPUT' };
  page.frame();
  assert.equal(page.keys('keydown').length, 3, 'no new keydown while an input is focused');
  page.document.activeElement = page.document.body;

  // Turning the feature off stops the loop and releases keys.
  page.frame();
  assert.equal(page.keys('keydown').length, 5);
  page.sendConfig({ enabled: true, target: 'switch', map: SWAP_MAP, keyboard: { enabled: false } });
  assert.deepEqual(page.keys('keyup').length, 5, 'held keys released immediately on disable');
  page.frame();
  assert.equal(page.pendingFrames(), 0, 'loop stopped');
});
