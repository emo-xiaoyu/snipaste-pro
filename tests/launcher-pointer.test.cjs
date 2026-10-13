const test = require('node:test');
const assert = require('node:assert/strict');

test('pointer geometry maps each direction while leaving the center and outside unarmed', async () => {
  const { launcherPointerAt } = await import('../src/launcher-pointer.js');
  for (const [x, y, sector] of [[0, -0.8, 0], [0.8, 0, 1], [0, 0.8, 2], [-0.8, 0, 3]]) {
    const point = launcherPointerAt(x, y);
    assert.equal(point.sector, sector);
    assert.ok(Math.hypot(point.x, point.y) > 0.43);
    assert.ok(Math.hypot(point.x, point.y) < 0.59);
  }
  assert.equal(launcherPointerAt(0, 0).sector, null);
  assert.equal(launcherPointerAt(0.1, 0.1).sector, null);
  assert.equal(launcherPointerAt(0, 1.2).sector, null);
});

async function wheelHarness({ reducedMotion = false } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { transformWithEsbuild } = await import('vite');
  const pointerModule = await import('../src/launcher-pointer.js');
  const { code } = await transformWithEsbuild(fs.readFileSync(path.join(__dirname, '../src/LauncherWheel.jsx'), 'utf8'), 'LauncherWheel.jsx', { loader: 'jsx', format: 'cjs', jsx: 'automatic' });
  const slots = [];
  const timers = new Map();
  const frames = new Map();
  const pointerStyle = new Map();
  const listeners = new Map();
  const opened = [];
  let cursor = 0;
  let now = 0;
  let timerId = 0;
  let effects = [];
  let selection = 0;
  const controlsRef = { current: null };
  const module = { exports: {} };
  const react = {
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useEffect(callback, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps?.every((value, i) => Object.is(value, old.deps[i]))) return;
      effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === './launcher-pointer.js') return pointerModule;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      return {};
    },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, time: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(fn) { const id = ++timerId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    window: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {}, matchMedia: () => ({ matches: reducedMotion, addEventListener() {}, removeEventListener() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
  });
  let wheel;
  let handle;
  let options;
  function render() {
    cursor = 0; effects = [];
    const tree = module.exports.LauncherWheel({ selection, onSelectionChange: (value) => { selection = value; }, onOpen: (value) => opened.push(value), optionRefs: { current: [] }, controlsRef });
    wheel = tree.props.children;
    wheel.props.ref.current = { getBoundingClientRect: () => ({ left: 20, top: 20, width: 480, height: 480 }) };
    options = wheel.props.children[1];
    handle = wheel.props.children.at(-1);
    handle.props.ref.current = { style: { setProperty: (key, value) => pointerStyle.set(key, value) } };
    wheel.props.children[2].props.children.props.ref.current = { setAttribute() {} };
    handle.props.children[0].props.ref.current = { style: {} };
    for (const effect of effects) effect();
  }
  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const event = (x, y) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, currentTarget: target, preventDefault() {} });
  render();
  return {
    opened, controlsRef, listeners, render,
    begin: (x = 260, y = 260) => handle.props.onPointerDown(event(x, y)),
    move: (x, y) => handle.props.onPointerMove(event(x, y)),
    release: (x, y) => { handle.props.onPointerUp(event(x, y)); handle.props.onClick(); },
    hover: (index) => options[index].props.onPointerEnter({ pointerType: 'mouse' }),
    click: (index) => options[index].props.onClick(),
    leave: () => wheel.props.onPointerLeave(),
    cancelPointer: () => handle.props.onPointerCancel(),
    pointerX: () => parseFloat(pointerStyle.get('--pointer-x')),
    advance(ms) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 1000 / 60);
        for (const [id, fn] of [...frames]) { if (frames.has(id)) { frames.delete(id); fn(now); } }
        for (const [id, task] of [...timers]) { if (task.time <= now && timers.has(id)) { timers.delete(id); task.fn(); } }
      }
    },
  };
}

test('a long held drag never opens until release, then activates exactly once', async () => {
  const h = await wheelHarness();
  h.begin(); h.move(260, 80);
  h.advance(5000); assert.deepEqual(h.opened, []);
  h.release(260, 80); assert.deepEqual(h.opened, [0]);
  h.advance(1000); assert.deepEqual(h.opened, [0]);
});

test('crossing sectors selects only the final release destination', async () => {
  const h = await wheelHarness();
  h.begin(); h.move(260, 80); h.advance(1000);
  h.move(440, 260); h.advance(1000); assert.deepEqual(h.opened, []);
  h.release(440, 260); assert.deepEqual(h.opened, [1]);
});

test('returning to center, losing focus, or keyboard cancellation prevents activation', async () => {
  for (const cancel of [(h) => h.move(260, 260), (h) => h.listeners.get('blur')(), (h) => h.controlsRef.current.cancel(), (h) => h.cancelPointer()]) {
    const h = await wheelHarness();
    h.begin(); h.move(80, 260); h.advance(300); cancel(h);
    h.release(260, 260);
    h.advance(1000); assert.deepEqual(h.opened, []);
  }
});

test('hovering never opens a destination; clicking opens it immediately', async () => {
  for (let index = 0; index < 4; index += 1) {
    const h = await wheelHarness();
    h.hover(index); h.advance(5000); assert.deepEqual(h.opened, []);
    h.click(index); assert.deepEqual(h.opened, [index]);
  }
  const h = await wheelHarness();
  h.hover(2); h.advance(300); h.leave(); h.advance(1000);
  assert.deepEqual(h.opened, []);
  h.click(3); assert.deepEqual(h.opened, [3]);
});

test('center clicks and releases outside the wheel are canceled', async () => {
  const h = await wheelHarness();
  h.begin(); h.release(260, 260); assert.deepEqual(h.opened, []);
  h.begin(); h.move(440, 260); h.release(600, 260);
  assert.deepEqual(h.opened, []);
});

test('spring motion gives the held pointer weight and a damped return to the anchor', async () => {
  const { stepLauncherSpring, launcherPointerAt } = await import('../src/launcher-pointer.js');
  const target = launcherPointerAt(0.8, 0);
  let state = { x: 0, y: 0, vx: 0, vy: 0 };
  state = stepLauncherSpring(state, target, 1 / 60, true);
  assert.ok(state.x > 0 && state.x < target.x);
  for (let i = 0; i < 100; i += 1) state = stepLauncherSpring(state, target, 1 / 60, true);
  assert.equal(state.x, target.x);
  let crossedAnchor = false;
  for (let i = 0; i < 200; i += 1) {
    state = stepLauncherSpring(state, { x: 0, y: 0 }, 1 / 60);
    if (state.x < 0) crossedAnchor = true;
  }
  assert.equal(crossedAnchor, true);
  assert.equal(state.x, 0);
  assert.equal(state.vx, 0);
});

test('gripping off-center does not jump, and reduced motion remains functional', async () => {
  const h = await wheelHarness({ reducedMotion: true });
  h.begin(272, 260); h.move(272, 260);
  assert.equal(h.pointerX(), 0);
  h.move(440, 260);
  assert.ok(h.pointerX() > 0);
  h.release(440, 260);
  assert.deepEqual(h.opened, [1]);
  assert.equal(h.pointerX(), 0);
});
