const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('native F4 and renderer keys save the current re-annotation task', async () => {
  const { transformWithEsbuild } = await import('vite');
  const source = fs.readFileSync(path.join(__dirname, '../src/screenshot.jsx'), 'utf8');
  const { code } = await transformWithEsbuild(source, 'screenshot.jsx', { loader: 'jsx', format: 'cjs', jsx: 'automatic' });
  const modules = {};
  for (const name of ['screenshot-annotations', 'screenshot-selection', 'screenshot-editor-layout']) {
    modules[`./${name}.js`] = await import(`../src/${name}.js`);
  }
  const slots = [];
  let cursor = 0;
  let effects = [];
  let component;
  let begin;
  let nativePin;
  let keyDown;
  const saved = [];
  const hooks = {
    useRef(value) { const index = cursor++; return slots[index] ||= { current: value }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps?.every((value, i) => Object.is(value, old.deps?.[i]))) return;
      effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
    },
  };
  const drawing = new Proxy({}, { get: () => () => {} });
  const canvas = () => ({ getContext: () => drawing, toBlob: (callback) => callback({ arrayBuffer: async () => new ArrayBuffer(4) }) });
  const context = {
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === 'react-dom/client') return { createRoot: () => ({ render: (element) => { component = element.type; } }) };
      return modules[name] || {};
    },
    window: {
      innerWidth: 1000, innerHeight: 800,
      addEventListener: (name, fn) => { if (name === 'keydown') keyDown = fn; },
      removeEventListener() {},
      clipboardAPI: {
        onScreenshotBegin: (fn) => { begin = fn; return () => {}; },
        onScreenshotPinRequest: (fn) => { nativePin = fn; return () => {}; },
        screenshotRendererReady() {}, screenshotReady() {},
        saveScreenshot: async (payload) => { saved.push(payload); return { success: true }; },
      },
    },
    document: { createElement: canvas, getElementById: () => ({}) },
    Image: class { naturalWidth = 1000; naturalHeight = 800; set src(value) { this.onload(); } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console,
  };
  vm.runInNewContext(code, context);
  function render() {
    cursor = 0;
    effects = [];
    component();
    for (const effect of effects) effect();
  }
  render();
  for (const id of ['pin-a', 'pin-b']) {
    begin({ imageUrl: 'fixture', initialSelection: { x: 10, y: 20, width: 300, height: 200 }, editPinId: id });
    render();
    await nativePin();
    assert.equal(saved.at(-1).editPinId, id);
  }
  begin({ imageUrl: 'fixture', initialSelection: { x: 10, y: 20, width: 300, height: 200 }, editPinId: 'pin-c' });
  render();
  keyDown({ key: 'F4', preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(saved.at(-1).editPinId, 'pin-c');
});
