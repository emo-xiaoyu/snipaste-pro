const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Exercise the real orchestration/IPC code with isolated OS and disk adapters.
// No app startup, global shortcuts, user clipboard, or history files are touched.
function harness({ writeFile = async () => {}, writeFiles = async () => {}, rename = async () => {}, foreground = async () => null, capturePage = async () => {}, keysDown = async () => true } = {}) {
  const handlers = new Map();
  const messages = [];
  const calls = [];
  const positions = [];
  let cursorPoint = { x: 300, y: 300 };
  let mainSize = { x: 0, y: 0, width: 520, height: 520 };
  const boundsCommits = [];
  const appEvents = new Map();
  const mainPath = path.resolve(__dirname, '../electron/main.cjs');
  const localRequire = createRequire(mainPath);
  const image = {
    isEmpty: () => false, getSize: () => ({ width: 1000, height: 100 }),
    toPNG: () => Buffer.from('png'), crop() { return this; },
  };
  class Window {
    constructor() { this.webContents = { send() {} }; }
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
    loadFile() {}
    on() {}
    setOpacity() {}
    setContentBounds(bounds) { this.bounds = bounds; }
    setAspectRatio() {}
    hide() { calls.push('hide'); }
  }
  const bridge = {
    isAvailable: () => true, readFiles: async () => ['E:\\one.txt', 'E:\\two.txt'],
    writeFiles: async (files) => { calls.push(['files', files]); await writeFiles(files); },
    paste: async () => { calls.push('paste'); },
    foreground,
    keysDown,
    captureDisplay: async () => {},
  };
  const electron = {
    app: { requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: (name, fn) => appEvents.set(name, fn), getPath: () => 'E:\\temp', quit: () => calls.push('quit') },
    BrowserWindow: Window,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    clipboard: {
      writeText: (text) => calls.push(['text', text]), writeImage: () => calls.push('image'),
      availableFormats: () => ['FileNameW'],
    },
    nativeImage: { createFromBuffer: () => image, createFromPath: () => image },
    screen: {
      getCursorScreenPoint: () => ({ ...cursorPoint }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
  };
  const context = vm.createContext({
    Buffer, process, console, calls, messages, positions, capturePage, __dirname: path.dirname(mainPath),
    mainGeometry: {
      getBounds: () => mainSize,
      setBounds: (bounds) => { mainSize = { ...bounds }; boundsCommits.push({ ...bounds }); positions.push({ x: bounds.x, y: bounds.y }); },
      setSize: (width, height) => { mainSize = { width, height }; },
      setPosition: (x, y) => positions.push({ x, y }),
    },
    setTimeout: () => 0, clearTimeout() {}, clearInterval() {},
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs') return {
        ...fs, existsSync: () => false, readFileSync: () => Buffer.from('png'),
        promises: { writeFile, rename, unlink: async () => {} },
      };
      if (name === './windows-bridge.cjs') return { WindowsBridge: class { constructor() { return bridge; } } };
      if (name === './shortcut-hold.cjs') {
        const hold = localRequire(name);
        return { ...hold, createShortcutHold: (options) => hold.createShortcutHold({ ...options, schedule: () => 0, cancel() {} }) };
      }
      return localRequire(name);
    },
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8') + `
    globalThis.qa = {
      state, addText, addImage, addFiles, inspectClipboard, openPinWindow, captureCurrentDisplay, writeStoreAsync, showWindow, shortcutHold,
      setStorePath(value) { storePath = value; },
      pins: pinWindows,
      setup() {
        imagesDir = 'E:\\temp';
        mainWindow = { isDestroyed: () => false, isVisible: () => false,
          ...mainGeometry, show() {}, focus() {},
          hide: () => calls.push('hide'), webContents: { capturePage, focus() {}, send: (...args) => messages.push(args) } };
      }
    };`, context);
  context.qa.setup();
  return { ...context.qa, calls, messages, handlers, image, appEvents, positions, boundsCommits, setCursor: (value) => { cursorPoint = value; } };
}

test('new text and file captures remove trimmed history from the renderer', () => {
  for (const kind of ['text', 'file']) {
    const h = harness();
    h.state.preferences.historyLimit = 20;
    h.state.entries = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, type: 'text' }));
    if (kind === 'text') h.addText('new item');
    else h.addFiles(['E:\\new.txt']);
    assert.equal(h.state.entries.length, 20);
    assert.deepEqual([...h.messages.at(-1)[1].removedIds], ['old-19']);
  }
});

test('clipboard history preserves code indentation and trailing newlines', () => {
  const h = harness();
  const entry = h.addText('    print("hello")\r\n');
  assert.equal(entry.content, '    print("hello")\n');
});

test('image write completion never resurrects a deleted entry', async () => {
  let finishWrite;
  const h = harness({ writeFile: () => new Promise((resolve) => { finishWrite = resolve; }) });
  const entry = h.addImage(h.image);
  await h.handlers.get('clipboard:delete-entry')({}, entry.id);
  finishWrite();
  await new Promise(setImmediate);
  assert.equal(h.messages.some(([, delta]) => delta.capturedEntry?.id === entry.id), false);
});

test('delayed image broadcasts retain chronological order', async () => {
  let finishWrite;
  const h = harness({ writeFile: () => new Promise((resolve) => { finishWrite = resolve; }) });
  const entry = h.addImage(h.image);
  h.addText('copied after image');
  finishWrite();
  await new Promise(setImmediate);
  const delta = h.messages.find(([, value]) => value.capturedEntry?.id === entry.id)[1];
  assert.equal(delta.capturedIndex, 1);
});

test('quitting waits for image persistence and only resumes exit once', async () => {
  let finishWrite;
  const h = harness({ writeFile: () => new Promise((resolve) => { finishWrite = resolve; }) });
  h.addImage(h.image);
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  h.appEvents.get('before-quit')(event);
  h.appEvents.get('before-quit')(event);
  assert.equal(h.calls.includes('quit'), false);
  finishWrite();
  await new Promise(setImmediate);
  assert.equal(prevented, 2);
  assert.equal(h.calls.filter((call) => call === 'quit').length, 1);
});

test('explicit quick pins accept an identical crop more than once', async () => {
  const h = harness();
  await h.captureCurrentDisplay({ pinImmediately: true });
  await h.captureCurrentDisplay({ pinImmediately: true });
  assert.equal(h.state.entries.length, 2);
  assert.equal(h.pins.size, 2);
  assert.equal(h.calls.filter((call) => call === 'image').length, 2);
});

test('history pins preserve the aspect ratio of a narrow screenshot', () => {
  const h = harness();
  const entry = h.addImage(h.image);
  assert.equal(h.openPinWindow(entry, { image: h.image }).success, true);
  const pin = h.pins.get(entry.id);
  assert.equal(pin.bounds.width, 520);
  assert.equal(pin.bounds.height, 52);
});

test('file paste awaits the native file-drop payload before sending Ctrl+V', async () => {
  let finishWrite;
  const h = harness({ writeFiles: () => new Promise((resolve) => { finishWrite = resolve; }) });
  const entry = h.addFiles(['E:\\one.txt', 'E:\\two.txt']);
  const result = h.handlers.get('clipboard:paste-entry')({}, entry.id);
  assert.equal(h.calls.includes('paste'), false);
  finishWrite();
  assert.equal((await result).success, true);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), ['files', 'hide', 'paste']);
});

test('a native file clipboard failure does not hide the app or send Ctrl+V', async () => {
  const h = harness({ writeFiles: async () => { throw new Error('clipboard busy'); } });
  const entry = h.addFiles(['E:\\one.txt']);
  const result = await h.handlers.get('clipboard:paste-entry')({}, entry.id);
  assert.equal(result.success, false);
  assert.equal(result.message, 'clipboard busy');
  assert.equal(h.calls.includes('hide'), false);
  assert.equal(h.calls.includes('paste'), false);
});

test('plain path text still pastes as text, and native file capture retains all paths', async () => {
  const h = harness();
  const entry = h.addText('E:\\one.txt');
  assert.equal((await h.handlers.get('clipboard:paste-entry')({}, entry.id)).success, true);
  assert.equal(h.calls[0][0], 'text');
  await h.inspectClipboard();
  assert.equal(h.state.entries[0].files.length, 2);
});

test('store writes serialize commits so a stale rename cannot win', async () => {
  const writes = [];
  const renames = [];
  const complete = [];
  const h = harness({
    writeFile: (file, snapshot) => {
      writes.push(JSON.parse(snapshot));
      return new Promise((resolve) => complete.push(resolve));
    },
    rename: async (file) => { renames.push(file); },
  });
  h.setStorePath('E:\\temp\\store.json');
  h.state.shortcut = 'Alt+A';
  const first = h.writeStoreAsync();
  await new Promise(setImmediate);
  h.state.shortcut = 'Alt+B';
  const second = h.writeStoreAsync();
  await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  complete[0]();
  await first;
  await new Promise(setImmediate);
  assert.equal(writes.length, 2);
  complete[1]();
  await second;
  assert.equal(renames.length, 1);
  assert.equal(writes.at(-1).shortcut, 'Alt+B');
});

test('every tray or second-instance invocation repositions at the current cursor', () => {
  const h = harness();
  h.setCursor({ x: 800, y: 600 }); h.showWindow();
  h.setCursor({ x: 1500, y: 400 }); h.showWindow();
  assert.deepEqual(h.positions, [{ x: 540, y: 340 }, { x: 1240, y: 140 }]);
});

test('shortcut positioning retains the invocation cursor while foreground lookup is pending', async () => {
  let finishForeground;
  const h = harness({ foreground: () => new Promise((resolve) => { finishForeground = resolve; }) });
  h.setCursor({ x: 800, y: 600 });
  const result = h.showWindow({ fromShortcut: true });
  h.setCursor({ x: 1400, y: 700 });
  finishForeground(null);
  await result;
  assert.deepEqual(h.positions, [{ x: 540, y: 340 }]);
});

test('opening content from any sector preserves the wheel center and commits bounds once', async () => {
  for (const point of [{ x: 800, y: 430 }, { x: 970, y: 600 }, { x: 800, y: 770 }, { x: 630, y: 600 }]) {
    const h = harness();
    h.setCursor({ x: 800, y: 600 }); h.showWindow();
    h.setCursor(point);
    await h.handlers.get('window:set-mode')({}, 'clipboard');
    assert.equal(h.boundsCommits.length, 2);
    assert.deepEqual(h.boundsCommits[1], { x: 530, y: 240, width: 540, height: 720 });
    h.setCursor({ x: 1200, y: 800 });
    await h.handlers.get('window:set-mode')({}, 'launcher');
    assert.deepEqual(h.boundsCommits[2], { x: 540, y: 340, width: 520, height: 520 });
  }
});

test('navigation waits for the painted page and a fresh invocation cancels a pending resize', async () => {
  let finishPaint;
  const h = harness({ capturePage: () => new Promise((resolve) => { finishPaint = resolve; }) });
  h.setCursor({ x: 800, y: 600 }); h.showWindow();
  const navigation = h.handlers.get('window:set-mode')({}, 'clipboard');
  assert.equal(h.boundsCommits.length, 1);
  h.setCursor({ x: 1400, y: 500 }); h.showWindow();
  finishPaint();
  assert.equal((await navigation).success, false);
  assert.equal(h.boundsCommits.length, 2);
  assert.deepEqual(h.boundsCommits.at(-1), { x: 1140, y: 240, width: 520, height: 520 });
});

test('shortcut repeats preserve the current hold and releasing either key hides the wheel', async () => {
  for (const keyCode of [18, 86]) {
    const h = harness();
    h.setCursor({ x: 800, y: 600 });
    await h.showWindow({ fromShortcut: true });
    const sessionId = h.shortcutHold.sessionId();
    h.setCursor({ x: 1200, y: 700 });
    await h.showWindow({ fromShortcut: true });
    assert.equal(h.boundsCommits.length, 1);
    h.shortcutHold.keyUp(keyCode);
    assert.equal(h.calls.filter((call) => call === 'hide').length, 1);
    assert.equal(h.messages.at(-1)[0], 'window:shortcut-released');
    assert.equal((await h.handlers.get('launcher:activate')({}, { sessionId })).success, false);
  }
});

test('releasing the shortcut during foreground lookup never reveals a stale launcher', async () => {
  let finishForeground;
  const h = harness({ foreground: () => new Promise((resolve) => { finishForeground = resolve; }) });
  const opening = h.showWindow({ fromShortcut: true });
  h.shortcutHold.keyUp(86);
  finishForeground(null);
  await opening;
  assert.equal(h.boundsCommits.length, 0);
});

test('a selected destination survives release, and repeats cannot reopen the launcher', async () => {
  const h = harness();
  await h.showWindow({ fromShortcut: true });
  assert.equal((await h.handlers.get('launcher:activate')({}, { sessionId: h.shortcutHold.sessionId() })).success, true);
  await h.showWindow({ fromShortcut: true });
  assert.equal(h.boundsCommits.length, 1);
  h.shortcutHold.keyUp(18);
  assert.equal(h.calls.includes('hide'), false);
});

test('a delayed click from an earlier hold cannot commit a newer wheel session', async () => {
  const h = harness();
  await h.showWindow({ fromShortcut: true });
  const oldSession = h.shortcutHold.sessionId();
  h.shortcutHold.keyUp(86);
  await h.showWindow({ fromShortcut: true });
  assert.equal((await h.handlers.get('launcher:activate')({}, { sessionId: oldSession })).success, false);
  assert.equal(h.shortcutHold.isPending(), true);
  h.shortcutHold.keyUp(18);
  assert.equal(h.calls.filter((call) => call === 'hide').length, 2);
});
