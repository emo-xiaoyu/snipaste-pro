const { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_PREFERENCES,
  capturePinBounds,
  classifyText,
  coerceImageBytes,
  defaultCaptureRegion,
  cursorWindowPosition,
  detectSensitive,
  entryTitle,
  fileFingerprint,
  hashBuffer,
  mergePreferences,
  migrateEntry,
  normalizeText,
  isScreenshotEntry,
  resolvePasteDelay,
  resetPinBounds,
  textFingerprint,
  zoomPinBounds,
} = require('./clipboard-core.cjs');
const { createPinOcrCache } = require('./pin-ocr-cache.cjs');
const { createWinOcrService } = require('./win-ocr-core.cjs');
const { WindowsBridge } = require('./windows-bridge.cjs');
const { createShortcutHold, shortcutKeyGroups } = require('./shortcut-hold.cjs');

const DEFAULT_SHORTCUT = 'Alt+V';
const DEFAULT_SCREENSHOT_SHORTCUTS = Object.freeze({
  capture: 'Alt+Shift+S',
  quickPin: 'Alt+Shift+P',
  history: 'Alt+Shift+V',
  historyPin: 'Enter',
});
const HISTORY_LIMIT = 120;
const POLL_INTERVAL = 650;

let mainWindow;
let mainWindowModeRevision = 0;
let captureWindow;
let screenshotWindow;
let screenshotHistoryWindow;
let warmPinWindow;
let tray;
const pinWindows = new Map();
let pollTimer;
let pollInFlight = false;
let lastClipboardSequence = null;
let state = {
  entries: [],
  shortcut: DEFAULT_SHORTCUT,
  screenshotShortcuts: { ...DEFAULT_SCREENSHOT_SHORTCUTS },
  preferences: { ...DEFAULT_PREFERENCES },
  pinnedScreenshots: [],
};
let storePath;
let imagesDir;
let lastFingerprint = '';
let suppressFingerprint = '';
let previousWindowHandle = null;
let captureHideTimer;
let lastExternalSource = null;
let sourceReadPending = false;
let currentCapture = null;
let shortcutRecordingActive = false;
let pendingScreenshotPayload = null;
let screenshotRendererReady = false;
let screenshotPinShortcutRegistered = false;
let desktopCapturePrewarmed = false;
let storeRevision = 0;
let storeWriteQueue = Promise.resolve();
const pendingImageWrites = new Set();
let shutdownReady = false;
let shutdownStarted = false;
const thumbnailCache = new Map();
const windowsBridge = new WindowsBridge();
const shortcutHold = createShortcutHold({
  keysDown: (groups) => windowsBridge.keysDown(groups),
  onRelease: () => {
    mainWindowModeRevision += 1;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:shortcut-released');
    mainWindow.hide();
  },
});
const winOcrService = createWinOcrService();

function imageFromPinSource(source) {
  if (Buffer.isBuffer(source?.bytes) && source.bytes.length) return nativeImage.createFromBuffer(source.bytes);
  if (source?.imagePath && fs.existsSync(source.imagePath)) {
    try { return nativeImage.createFromPath(source.imagePath); } catch { /* fall through */ }
  }
  return source?.dataUrl ? nativeImage.createFromDataURL(String(source.dataUrl)) : nativeImage.createEmpty();
}

async function recognizePinImage(input) {
  const persistedPath = typeof input === 'object' && input?.imagePath && fs.existsSync(input.imagePath)
    ? input.imagePath
    : null;
  const image = imageFromPinSource(input);
  if (image.isEmpty()) throw new Error('无法读取贴图内容');
  const sourceSize = image.getSize();
  let imagePath = persistedPath;
  let temporaryPath;
  if (!imagePath) {
    temporaryPath = path.join(app.getPath('temp'), `pasty-ocr-${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(temporaryPath, image.toPNG());
    imagePath = temporaryPath;
  }
  try {
    const result = await winOcrService.recognize(imagePath, { sourceSize });
    if (!result.items.length) throw new Error('没有识别到可选择的文字或数字');
    return {
      success: true,
      engine: 'windows',
      charCount: result.text.length,
      confidence: result.confidence,
      imageSize: sourceSize,
      items: result.items,
    };
  } finally {
    if (temporaryPath) void fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

const pinOcrCache = createPinOcrCache({ limit: 64, load: recognizePinImage });

function traceScreenshotTiming(label) {
  const timingPath = process.env.PASTY_QA_TIMING;
  if (!timingPath) return;
  try { fs.appendFileSync(timingPath, `${Date.now()} ${label}\n`, 'utf8'); } catch {}
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function writeStore() {
  if (!storePath) return;
  storeRevision += 1;
  const tempPath = `${storePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, storePath);
}

function writeStoreAsync() {
  if (!storePath) return Promise.resolve();
  const revision = ++storeRevision;
  const tempPath = `${storePath}.${process.pid}.${revision}.tmp`;
  const snapshot = JSON.stringify(state, null, 2);
  const job = storeWriteQueue.then(async () => {
    if (revision !== storeRevision) return;
    await fs.promises.writeFile(tempPath, snapshot, 'utf8');
    if (revision !== storeRevision) {
      return fs.promises.unlink(tempPath).catch(() => {});
    }
    await fs.promises.rename(tempPath, storePath);
  }).catch((error) => {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    console.warn('Could not persist clipboard store asynchronously:', error.message);
  });
  storeWriteQueue = job;
  return job;
}

function loadStore() {
  storePath = path.join(app.getPath('userData'), 'clipboard-store.json');
  imagesDir = path.join(app.getPath('userData'), 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  if (!fs.existsSync(storePath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    state.entries = Array.isArray(parsed.entries) ? parsed.entries.map(migrateEntry) : [];
    state.shortcut = typeof parsed.shortcut === 'string' ? parsed.shortcut : DEFAULT_SHORTCUT;
    state.screenshotShortcuts = {
      ...DEFAULT_SCREENSHOT_SHORTCUTS,
      ...(parsed.screenshotShortcuts && typeof parsed.screenshotShortcuts === 'object' ? parsed.screenshotShortcuts : {}),
    };
    state.preferences = mergePreferences(parsed.preferences);
    // Desktop pin windows are session-only. Older builds persisted them and
    // reopened every pin after restart, which could flood the desktop.
    state.pinnedScreenshots = [];
    if (Array.isArray(parsed.pinnedScreenshots) && parsed.pinnedScreenshots.length) writeStore();
  } catch (error) {
    console.warn('Could not load clipboard store:', error.message);
  }
}

function safeReadImageFile(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) return null;
  try { return fs.readFileSync(imagePath); } catch { return null; }
}

function trimHistory() {
  const durable = state.entries.filter((entry) => entry.pinned || entry.custom);
  const limit = state.preferences?.historyLimit || HISTORY_LIMIT;
  const transient = state.entries.filter((entry) => !entry.pinned && !entry.custom).slice(0, limit);
  const keep = new Set([...durable, ...transient].map((entry) => entry.id));
  const removed = state.entries.filter((entry) => !keep.has(entry.id));
  if (removed.length) {
    state.entries = state.entries.filter((entry) => keep.has(entry.id));
    for (const entry of removed) {
      if (entry.imagePath) thumbnailCache.delete(entry.imagePath);
    }
    if (removed.some((entry) => entry.type === 'image')) scheduleImageGc();
  }
  return removed;
}

// Deletes stored images that no entry references anymore (history trim,
// entry deletion, or a previous crashed session). Debounced so bursts of
// captures only trigger one directory scan.
let imageGcTimer;
function scheduleImageGc(delay = 2500) {
  clearTimeout(imageGcTimer);
  imageGcTimer = setTimeout(runImageGc, delay);
}

function runImageGc() {
  imageGcTimer = null;
  if (!imagesDir) return;
  let names;
  try { names = fs.readdirSync(imagesDir); } catch { return; }
  const referenced = new Set(
    state.entries
      .filter((entry) => entry.type === 'image' && entry.imagePath)
      .map((entry) => path.basename(entry.imagePath)),
  );
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.png') || referenced.has(name)) continue;
    const filePath = path.join(imagesDir, name);
    try {
      fs.rmSync(filePath, { force: true });
      thumbnailCache.delete(filePath);
    } catch {}
  }
}

function thumbnailDataUrl(entry) {
  if (entry.type !== 'image' || !entry.imagePath || !fs.existsSync(entry.imagePath)) return null;
  if (thumbnailCache.has(entry.imagePath)) return thumbnailCache.get(entry.imagePath);
  try {
    const thumbnail = nativeImage.createFromPath(entry.imagePath).resize({ width: 300, quality: 'good' }).toDataURL();
    thumbnailCache.set(entry.imagePath, thumbnail);
    return thumbnail;
  } catch {
    return null;
  }
}

function publicState(extra = {}) {
  return {
    ...extra,
    shortcut: state.shortcut,
    screenshotShortcuts: state.screenshotShortcuts,
    preferences: state.preferences,
    entries: state.entries.map((entry) => ({
      ...entry,
      imageUrl: thumbnailDataUrl(entry),
      imagePath: undefined,
    })),
  };
}

function normalizeSource(source) {
  if (!source?.app || source.app.toLocaleLowerCase() === 'electron') return null;
  return { app: source.app, title: String(source.title || '').slice(0, 160), handle: String(source.handle || '') };
}

function refreshSourceContext() {
  if (sourceReadPending) return;
  sourceReadPending = true;
  windowsBridge.foreground().then((source) => {
    const normalized = normalizeSource(source);
    if (normalized) lastExternalSource = normalized;
  }).catch(() => {}).finally(() => { sourceReadPending = false; });
}

function getCachedSourceContext() {
  if (!state.preferences.trackSource) return null;
  refreshSourceContext();
  return lastExternalSource;
}

function mergeDuplicate(fingerprint, source) {
  const index = state.entries.findIndex((entry) => entry.fingerprint === fingerprint);
  if (index < 0) return null;
  const existing = state.entries[index];
  state.entries.splice(index, 1);
  existing.copyCount = Math.max(1, Number(existing.copyCount) || 1) + 1;
  existing.lastCopiedAt = Date.now();
  existing.createdAt = existing.lastCopiedAt;
  if (source) existing.source = source;
  state.entries.unshift(existing);
  const removed = trimHistory();
  writeStoreAsync();
  broadcastDelta({ capturedEntry: publicEntry(existing), removedIds: removed.map((entry) => entry.id) });
  showCaptureToast(existing);
  return existing;
}

function publicEntry(entry) {
  return { ...entry, imageUrl: thumbnailDataUrl(entry), imagePath: undefined };
}

function showCaptureToast(entry) {
  if (!state.preferences.showCopyToast || !captureWindow || captureWindow.isDestroyed()) return;
  captureWindow.webContents.send('capture:show', publicEntry(entry));
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  const bounds = captureWindow.getBounds();
  captureWindow.setPosition(x + width - bounds.width - 24, y + height - bounds.height - 24, false);
  captureWindow.showInactive();
  clearTimeout(captureHideTimer);
  captureHideTimer = setTimeout(() => captureWindow?.hide(), 2200);
}

// Full state sync is reserved for the initial window load and rare
// user-triggered resets; clipboard changes travel as small deltas so a
// capture does not re-ship every thumbnail over IPC.
function broadcast(extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard:state-changed', { full: true, ...publicState(extra) });
  }
}

function broadcastDelta(extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard:state-changed', { full: false, ...extra });
  }
}

function addText(content, options = {}) {
  const normalized = String(content ?? '').replace(/\0/g, '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return null;
  const html = state.preferences.captureRichText ? String(options.html || '') : '';
  const fingerprint = textFingerprint(normalized, html);
  if (!options.custom && fingerprint !== lastFingerprint) suppressFingerprint = '';
  if (!options.custom && (fingerprint === lastFingerprint || fingerprint === suppressFingerprint)) return null;
  const sensitive = detectSensitive(normalized);
  if (!options.custom && sensitive && state.preferences.protectSensitive) {
    lastFingerprint = fingerprint;
    broadcastDelta({ notice: `检测到${sensitive.label}，已跳过记录` });
    return null;
  }
  lastFingerprint = fingerprint;
  const source = options.source || getCachedSourceContext();
  if (!options.custom && state.preferences.mergeDuplicates) {
    const merged = mergeDuplicate(fingerprint, source);
    if (merged) return merged;
  }
  const type = options.type && options.type !== 'auto' ? options.type : classifyText(normalized);
  const now = Date.now();
  const entry = {
    id: crypto.randomUUID(),
    fingerprint,
    type,
    title: options.title?.trim() || entryTitle(normalized, type, options.files),
    content: normalized,
    html: html || undefined,
    files: options.files || undefined,
    createdAt: now,
    lastCopiedAt: now,
    copyCount: 1,
    formats: options.formats || ['text/plain'],
    source,
    sensitive: Boolean(sensitive),
    pinned: Boolean(options.pinned || options.custom),
    custom: Boolean(options.custom),
  };
  state.entries.unshift(entry);
  const removed = trimHistory();
  writeStoreAsync();
  broadcastDelta({ capturedEntry: publicEntry(entry), removedIds: removed.map((item) => item.id) });
  showCaptureToast(entry);
  return entry;
}

function addImage(image, options = {}) {
  if (!image || image.isEmpty()) return null;
  const png = Buffer.isBuffer(options.pngBuffer) && options.pngBuffer.length ? options.pngBuffer : image.toPNG();
  const digest = hashBuffer(png);
  const fingerprint = `image:${digest}`;
  if (!options.custom && fingerprint !== lastFingerprint) suppressFingerprint = '';
  if (!options.custom && !options.force && (fingerprint === lastFingerprint || fingerprint === suppressFingerprint)) return null;
  lastFingerprint = fingerprint;
  const source = options.source || getCachedSourceContext();
  if (!options.custom && !options.force && state.preferences.mergeDuplicates) {
    const merged = mergeDuplicate(fingerprint, source);
    if (merged) return merged;
  }
  const imagePath = path.join(imagesDir, `${digest}.png`);
  const needsImageWrite = !fs.existsSync(imagePath);
  const size = image.getSize();
  const now = Date.now();
  const entry = {
    id: crypto.randomUUID(),
    fingerprint,
    type: 'image',
    title: options.title?.trim() || `截图 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    content: `${size.width} × ${size.height} · PNG`,
    width: size.width,
    height: size.height,
    imagePath,
    createdAt: now,
    lastCopiedAt: now,
    copyCount: 1,
    formats: options.formats || ['image/png'],
    source,
    origin: options.origin || undefined,
    pinned: Boolean(options.pinned || options.custom),
    custom: Boolean(options.custom),
  };
  state.entries.unshift(entry);
  const removed = trimHistory();
  if (removed.length) broadcastDelta({ removedIds: removed.map((item) => item.id) });
  // Image bytes and the store both persist asynchronously; broadcast and the
  // toast follow once the thumbnail can actually be read from disk.
  const imageWrite = needsImageWrite ? fs.promises.writeFile(imagePath, png) : Promise.resolve();
  const persistence = imageWrite.then(() => writeStoreAsync()).then(() => {
    // The user may delete this image, or a later capture may trim it, while
    // its bytes are being written. Never resurrect it in the renderer.
    const capturedIndex = state.entries.findIndex((item) => item.id === entry.id);
    if (capturedIndex < 0) return;
    broadcastDelta({ capturedEntry: publicEntry(entry), capturedIndex });
    showCaptureToast(entry);
  }).catch((error) => {
    console.warn('Could not persist clipboard image:', error.message);
    broadcastDelta({ notice: '图片已记录，但本地历史写入失败' });
  });
  pendingImageWrites.add(persistence);
  void persistence.finally(() => pendingImageWrites.delete(persistence));
  return entry;
}

function addFiles(files, options = {}) {
  const validFiles = [...new Set((files || []).filter(Boolean).map((item) => path.normalize(item)))];
  if (!validFiles.length) return null;
  const fingerprint = fileFingerprint(validFiles);
  if (fingerprint !== lastFingerprint) suppressFingerprint = '';
  if (fingerprint === lastFingerprint || fingerprint === suppressFingerprint) return null;
  lastFingerprint = fingerprint;
  const source = options.source || getCachedSourceContext();
  if (state.preferences.mergeDuplicates) {
    const merged = mergeDuplicate(fingerprint, source);
    if (merged) return merged;
  }
  const now = Date.now();
  const entry = {
    id: crypto.randomUUID(), fingerprint, type: 'file',
    title: entryTitle('', 'file', validFiles), content: validFiles.join('\n'), files: validFiles,
    createdAt: now, lastCopiedAt: now, copyCount: 1, formats: options.formats || ['text/uri-list'], source,
    pinned: false, custom: false,
  };
  state.entries.unshift(entry);
  const removed = trimHistory();
  writeStoreAsync();
  broadcastDelta({ capturedEntry: publicEntry(entry), removedIds: removed.map((item) => item.id) });
  showCaptureToast(entry);
  return entry;
}

function readFilePaths(formats) {
  const uriFormat = formats.find((format) => /file-list|text\/uri-list/i.test(format));
  if (uriFormat) {
    const raw = clipboard.readBuffer(uriFormat).toString('utf8').replace(/\0/g, '');
    const paths = raw.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
      try { return line.startsWith('file:') ? decodeURIComponent(new URL(line).pathname).replace(/^\/(\w:)/, '$1') : line; } catch { return line; }
    });
    if (paths.length) return paths;
  }
  const fileDrop = formats.find((format) => /FileNameW/i.test(format));
  if (fileDrop) {
    return clipboard.readBuffer(fileDrop).toString('utf16le').split('\0').filter(Boolean);
  }
  return [];
}

async function inspectClipboard() {
  try {
    if (state.preferences.trackSource) refreshSourceContext();
    const formats = clipboard.availableFormats();
    if (state.preferences.captureFiles) {
      // FileNameW contains only one path on some Windows applications. Read
      // the native file-drop list to retain every selected file and UNC path.
      let files = [];
      if (process.platform === 'win32' && windowsBridge.isAvailable()) {
        try { files = await windowsBridge.readFiles(); } catch {}
      }
      if (!Array.isArray(files) || !files.length) files = readFilePaths(formats);
      if (files.length) { addFiles(files, { formats }); return; }
    }
    const hasImage = formats.some((format) => /image/i.test(format));
    if (hasImage && state.preferences.captureImages) {
      const image = clipboard.readImage();
      if (!image.isEmpty()) addImage(image, { formats });
      return;
    }
    if (state.preferences.captureText && formats.some((format) => /text|html/i.test(format))) {
      addText(clipboard.readText(), { html: clipboard.readHTML(), formats });
    }
  } catch (error) {
    console.warn('Clipboard read failed:', error.message);
  }
}

// Polling fast path: when the Windows bridge is healthy, the clipboard
// sequence number lets us skip re-reading (and PNG re-encoding) unchanged
// clipboard content on every tick.
async function pollClipboard() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    if (process.platform === 'win32' && windowsBridge.isAvailable()) {
      try {
        const sequence = await windowsBridge.clipboardSequence();
        if (Number.isFinite(sequence) && lastClipboardSequence === sequence) return;
        lastClipboardSequence = sequence;
      } catch {
        // Bridge hiccup on the fast path: fall through to a full inspect.
      }
    }
    await inspectClipboard();
  } finally {
    pollInFlight = false;
  }
}

async function writeEntryToClipboard(entry) {
  if (entry.type === 'image') {
    if (!entry.imagePath || !fs.existsSync(entry.imagePath)) throw new Error('图片文件已不存在');
    const image = nativeImage.createFromPath(entry.imagePath);
    suppressFingerprint = entry.fingerprint;
    clipboard.writeImage(image);
  } else if (entry.type === 'file') {
    if (entry.files?.length) await windowsBridge.writeFiles(entry.files);
    else clipboard.writeText(entry.content || '');
    suppressFingerprint = entry.fingerprint;
  } else {
    suppressFingerprint = entry.fingerprint;
    if (entry.html) clipboard.write({ text: entry.content || '', html: entry.html });
    else clipboard.writeText(entry.content || '');
  }
  lastFingerprint = entry.fingerprint;
}

function sendPasteKeystroke(targetHandle, targetSource) {
  const delayMs = resolvePasteDelay(state.preferences, targetSource);
  windowsBridge.paste(targetHandle, delayMs).catch(() => {
    broadcastDelta({ notice: '内容已复制；自动粘贴暂时不可用。' });
  });
}

function setMainWindowMode(mode, invocationCursor = null) {
  mainWindowModeRevision += 1;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.getBounds();
  // Only a fresh invocation follows the mouse. Selecting a sector must not
  // relocate the panel toward that click; navigation keeps the window center.
  const anchor = invocationCursor || { x: current.x + current.width / 2, y: current.y + current.height / 2 };
  const size = mode === 'clipboard' ? { width: 540, height: 720 } : { width: 520, height: 520 };
  const { workArea } = screen.getDisplayNearestPoint(anchor);
  const fitted = { width: Math.min(size.width, workArea.width), height: Math.min(size.height, workArea.height) };
  const position = cursorWindowPosition(workArea, fitted, anchor);
  // Commit size and position together, rather than moving the old-sized wheel
  // in one native update and resizing it in another.
  mainWindow.setBounds({ ...position, ...fitted }, false);
}

function showWindow(options = {}) {
  if (!mainWindow) return;
  const invocationCursor = screen.getCursorScreenPoint();
  if (options.fromShortcut) {
    if (shortcutRecordingActive) return;
    const session = shortcutHold.start(state.shortcut || DEFAULT_SHORTCUT);
    if (!session) return;
    return Promise.all([windowsBridge.foreground().catch(() => null), session.ready]).then(async ([source, held]) => {
      if (!held || !shortcutHold.isActive(session) || !shortcutHold.isPending() || !await shortcutHold.check(session)) return;
      const normalized = normalizeSource(source);
      if (normalized) {
        lastExternalSource = normalized;
        previousWindowHandle = normalized.handle;
      } else {
        previousWindowHandle = lastExternalSource?.handle || null;
      }
      revealWindow(invocationCursor, { shortcutKeys: session.groups.flat(), shortcutSession: session.id });
    });
  }
  shortcutHold.stop();
  revealWindow(invocationCursor);
}

function revealWindow(cursor, invocation = null) {
  setMainWindowMode('launcher', cursor);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('window:open-launcher', invocation);
}

function quitApplication() {
  app.isQuitting = true;
  app.quit();
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'pasty-tray.png');
  const sourceIcon = nativeImage.createFromPath(iconPath);
  if (sourceIcon.isEmpty()) {
    console.warn('Tray icon could not be loaded:', iconPath);
    return;
  }
  const trayIcon = sourceIcon.resize({ width: 20, height: 20, quality: 'best' });
  tray = new Tray(trayIcon);
  tray.setToolTip('Pasty · 剪贴板与截图');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Pasty', click: () => showWindow() },
    { type: 'separator' },
    {
      label: '截图',
      click: () => captureCurrentDisplay().catch((error) => broadcastDelta({ notice: String(error.message || error) })),
    },
    {
      label: '快速截图并固定',
      click: () => captureCurrentDisplay({ pinImmediately: true }).catch((error) => broadcastDelta({ notice: String(error.message || error) })),
    },
    { label: '截图历史', click: () => showScreenshotHistory() },
    { type: 'separator' },
    { label: '退出 Pasty', click: quitApplication },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function registerAppShortcut(nextShortcut, options = {}) {
  if (!shortcutKeyGroups(nextShortcut)) return { success: false, message: '此快捷键暂不支持按住唤出，请使用字母、数字或标准功能键组合' };
  const previous = state.shortcut || DEFAULT_SHORTCUT;
  globalShortcut.unregister(previous);
  const success = globalShortcut.register(nextShortcut, () => showWindow({ fromShortcut: true }));
  if (!success) {
    globalShortcut.register(previous, () => showWindow({ fromShortcut: true }));
    return { success: false, message: '快捷键已被其他应用占用' };
  }
  state.shortcut = nextShortcut;
  if (options.persist !== false) {
    writeStoreAsync();
    broadcastDelta({ notice: `快捷键已更新为 ${nextShortcut}`, shortcut: state.shortcut });
  }
  return { success: true, shortcut: nextShortcut };
}

function configurableShortcutValues(appShortcut = state.shortcut, screenshotShortcuts = state.screenshotShortcuts) {
  return [appShortcut, screenshotShortcuts.capture, screenshotShortcuts.quickPin, screenshotShortcuts.history]
    .map((value) => String(value || '').trim());
}

function unregisterConfigurableShortcuts(appShortcut = state.shortcut, screenshotShortcuts = state.screenshotShortcuts) {
  for (const shortcut of configurableShortcutValues(appShortcut, screenshotShortcuts)) {
    if (shortcut) globalShortcut.unregister(shortcut);
  }
}

function restoreConfigurableShortcuts() {
  unregisterConfigurableShortcuts();
  registerAppShortcut(state.shortcut || DEFAULT_SHORTCUT, { persist: false });
  registerScreenshotShortcuts(state.screenshotShortcuts, { persist: false });
}

function setShortcutRecording(active) {
  shortcutHold.stop();
  shortcutRecordingActive = Boolean(active);
  if (shortcutRecordingActive) unregisterConfigurableShortcuts();
  else restoreConfigurableShortcuts();
  return { success: true, active: shortcutRecordingActive };
}

function updateAllShortcuts(nextAppShortcut, nextScreenshotShortcuts) {
  const previousAppShortcut = state.shortcut || DEFAULT_SHORTCUT;
  const previousScreenshotShortcuts = { ...DEFAULT_SCREENSHOT_SHORTCUTS, ...state.screenshotShortcuts };
  const candidateAppShortcut = String(nextAppShortcut || '').trim();
  if (!shortcutKeyGroups(candidateAppShortcut)) return { success: false, message: '主窗口快捷键不支持按住检测，请使用字母、数字或标准功能键组合' };
  const candidateScreenshotShortcuts = { ...DEFAULT_SCREENSHOT_SHORTCUTS, ...(nextScreenshotShortcuts || {}) };
  const values = configurableShortcutValues(candidateAppShortcut, candidateScreenshotShortcuts);
  if (values.some((value) => !value) || new Set(values.map((value) => value.toLocaleLowerCase())).size !== values.length) {
    return { success: false, message: '全局快捷键不能为空或重复' };
  }
  const historyPinShortcut = String(candidateScreenshotShortcuts.historyPin || '').trim();
  if (!historyPinShortcut) return { success: false, message: '历史截图钉到桌面的按键不能为空' };
  candidateScreenshotShortcuts.historyPin = historyPinShortcut;

  unregisterConfigurableShortcuts(previousAppShortcut, previousScreenshotShortcuts);
  const registered = [];
  const bindings = [
    [candidateAppShortcut, () => showWindow({ fromShortcut: true })],
    ...screenshotShortcutBindings(candidateScreenshotShortcuts),
  ];
  for (const [shortcut, handler] of bindings) {
    let success = false;
    try { success = globalShortcut.register(shortcut, handler); } catch {}
    if (!success) {
      for (const value of registered) globalShortcut.unregister(value);
      state.shortcut = previousAppShortcut;
      state.screenshotShortcuts = previousScreenshotShortcuts;
      restoreConfigurableShortcuts();
      return { success: false, message: `快捷键 ${shortcut} 已被其他应用占用，请换一个组合` };
    }
    registered.push(shortcut);
  }

  state.shortcut = candidateAppShortcut;
  state.screenshotShortcuts = candidateScreenshotShortcuts;
  if (shortcutRecordingActive) unregisterConfigurableShortcuts();
  writeStoreAsync();
  broadcastDelta({ notice: '快捷键已保存并生效', shortcut: state.shortcut, screenshotShortcuts: state.screenshotShortcuts });
  return {
    success: true,
    shortcut: state.shortcut,
    screenshotShortcuts: state.screenshotShortcuts,
  };
}

function screenshotShortcutBindings(shortcuts) {
  return [
    [shortcuts.capture, () => {
      traceScreenshotTiming('capture-shortcut-received');
      captureCurrentDisplay().catch((error) => broadcastDelta({ notice: String(error.message || error) }));
    }],
    [shortcuts.quickPin, () => captureCurrentDisplay({ pinImmediately: true }).catch((error) => broadcastDelta({ notice: String(error.message || error) }))],
    [shortcuts.history, showScreenshotHistory],
  ];
}

async function prewarmDesktopCapture() {
  if (process.platform === 'win32') return;
  if (desktopCapturePrewarmed) return;
  desktopCapturePrewarmed = true;
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 },
    });
  } catch {
    desktopCapturePrewarmed = false;
  }
}

async function captureDisplayImage(display) {
  if (process.platform === 'win32') {
    const capturePath = path.join(app.getPath('temp'), `pasty-capture-${process.pid}-${crypto.randomUUID()}.png`);
    try {
      await windowsBridge.captureDisplay(capturePath);
      const imageBytes = fs.readFileSync(capturePath);
      const image = nativeImage.createFromBuffer(imageBytes);
      if (!image.isEmpty()) {
        traceScreenshotTiming('capture-native-ready');
        return { image, imageBytes };
      }
    } catch (error) {
      console.warn('Native display capture failed, falling back to Electron:', error.message);
    } finally {
      try { fs.rmSync(capturePath, { force: true }); } catch {}
    }
  }
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.bounds.width * scale),
      height: Math.round(display.bounds.height * scale),
    },
  });
  const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法读取当前屏幕');
  traceScreenshotTiming('capture-electron-ready');
  return { image: source.thumbnail, imageBytes: source.thumbnail.toPNG() };
}

function registerScreenshotShortcuts(next = state.screenshotShortcuts, options = {}) {
  const previous = { ...DEFAULT_SCREENSHOT_SHORTCUTS, ...state.screenshotShortcuts };
  const candidate = { ...DEFAULT_SCREENSHOT_SHORTCUTS, ...(next || {}) };
  const values = screenshotShortcutBindings(candidate).map(([value]) => String(value || '').trim());
  if (values.some((value) => !value) || new Set(values.map((value) => value.toLocaleLowerCase())).size !== values.length) {
    return { success: false, message: '截图快捷键不能为空或重复' };
  }
  candidate.historyPin = String(candidate.historyPin || '').trim();
  if (!candidate.historyPin) return { success: false, message: '历史截图钉到桌面的按键不能为空' };
  if (values.some((value) => value.toLocaleLowerCase() === String(state.shortcut || '').toLocaleLowerCase())) {
    return { success: false, message: '截图快捷键不能和应用唤出快捷键相同' };
  }
  for (const [shortcut] of screenshotShortcutBindings(previous)) globalShortcut.unregister(shortcut);
  const registered = [];
  for (const [shortcut, handler] of screenshotShortcutBindings(candidate)) {
    if (!globalShortcut.register(shortcut, handler)) {
      for (const value of registered) globalShortcut.unregister(value);
      for (const [oldShortcut, oldHandler] of screenshotShortcutBindings(previous)) globalShortcut.register(oldShortcut, oldHandler);
      return { success: false, message: `快捷键 ${shortcut} 已被其他应用占用` };
    }
    registered.push(shortcut);
  }
  state.screenshotShortcuts = candidate;
  if (options.persist !== false) {
    writeStoreAsync();
    broadcastDelta({ notice: '截图快捷键已更新', screenshotShortcuts: candidate });
  }
  return { success: true, screenshotShortcuts: candidate };
}

async function captureCurrentDisplay(options = {}) {
  const shouldWaitForHiddenUi = Boolean(
    mainWindow?.isVisible()
    || captureWindow?.isVisible()
    || screenshotHistoryWindow?.isVisible(),
  );
  mainWindow?.hide();
  captureWindow?.hide();
  screenshotHistoryWindow?.hide();
  if (shouldWaitForHiddenUi) await new Promise((resolve) => setTimeout(resolve, 16));
  traceScreenshotTiming('capture-ui-hidden');
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { image: fullImage, imageBytes } = await captureDisplayImage(display);
  traceScreenshotTiming('capture-sources-ready');
  const region = defaultCaptureRegion(display.bounds, cursor);
  const sourceSize = fullImage.getSize();
  const scaleX = sourceSize.width / display.bounds.width;
  const scaleY = sourceSize.height / display.bounds.height;
  const cropX = Math.max(0, Math.round((region.x - display.bounds.x) * scaleX));
  const cropY = Math.max(0, Math.round((region.y - display.bounds.y) * scaleY));
  const cropped = fullImage.crop({
    x: cropX,
    y: cropY,
    width: Math.min(sourceSize.width - cropX, Math.round(region.width * scaleX)),
    height: Math.min(sourceSize.height - cropY, Math.round(region.height * scaleY)),
  });
  if (cropped.isEmpty()) throw new Error('无法截取鼠标附近区域');
  if (options.pinImmediately) {
    const entry = addImage(cropped, { formats: ['image/png'], origin: 'screenshot', force: true });
    if (!entry) return;
    clipboard.writeImage(cropped);
    openPinWindow(entry, { bounds: region, image: cropped });
    return;
  }
  const imagePayload = { imageBytes };
  traceScreenshotTiming('capture-png-ready');
  currentCapture = { display, imagePayload, sourceSize };
  openScreenshotEditor(display, imagePayload, display.bounds, {
    x: cropX,
    y: cropY,
    width: cropped.getSize().width,
    height: cropped.getSize().height,
  });
}

function openScreenshotEditor(display, imageSource, bounds = display.bounds, initialSelection = null, task = {}) {
  createScreenshotWindow();
  setScreenshotPinShortcut(true);
  screenshotWindow.setBounds(bounds);
  const imagePayload = typeof imageSource === 'string' ? { imageUrl: imageSource } : imageSource;
  pendingScreenshotPayload = { ...imagePayload, initialSelection, ...task };
  if (screenshotRendererReady) {
    screenshotWindow.webContents.send('screenshot:begin', pendingScreenshotPayload);
    pendingScreenshotPayload = null;
  }
}

function createScreenshotWindow() {
  if (screenshotWindow && !screenshotWindow.isDestroyed()) return screenshotWindow;
  screenshotWindow = new BrowserWindow({
    width: 1, height: 1, show: false, frame: false, transparent: true,
    resizable: false, movable: false, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  screenshotRendererReady = false;
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) screenshotWindow.loadURL(`${devUrl}/screenshot.html`);
  else screenshotWindow.loadFile(path.join(__dirname, '..', 'dist', 'client', 'screenshot.html'));
  screenshotWindow.webContents.on('did-start-loading', () => { screenshotRendererReady = false; });
  screenshotWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      closeScreenshotEditorTask();
    }
  });
  screenshotWindow.on('hide', () => setScreenshotPinShortcut(false));
  screenshotWindow.on('closed', () => { screenshotWindow = null; screenshotRendererReady = false; });
  return screenshotWindow;
}

function setScreenshotPinShortcut(active) {
  if (!active) {
    if (screenshotPinShortcutRegistered) globalShortcut.unregister('F4');
    screenshotPinShortcutRegistered = false;
    return false;
  }
  if (screenshotPinShortcutRegistered) return true;
  screenshotPinShortcutRegistered = globalShortcut.register('F4', () => {
    if (!screenshotWindow || screenshotWindow.isDestroyed() || !screenshotWindow.isVisible()) return;
    traceScreenshotTiming('f4-main-received');
    screenshotWindow.webContents.send('screenshot:pin-request');
  });
  return screenshotPinShortcutRegistered;
}

function showScreenshotHistory() {
  if (!screenshotHistoryWindow || screenshotHistoryWindow.isDestroyed()) {
    screenshotHistoryWindow = new BrowserWindow({
      width: 820, height: 650, minWidth: 620, minHeight: 480, show: false, frame: false,
      transparent: true, resizable: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: true,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) screenshotHistoryWindow.loadURL(`${devUrl}/screenshot-history.html`);
    else screenshotHistoryWindow.loadFile(path.join(__dirname, '..', 'dist', 'client', 'screenshot-history.html'));
    screenshotHistoryWindow.on('closed', () => { screenshotHistoryWindow = null; });
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = screenshotHistoryWindow.getBounds();
  screenshotHistoryWindow.setPosition(
    Math.round(display.workArea.x + (display.workArea.width - bounds.width) / 2),
    Math.round(display.workArea.y + (display.workArea.height - bounds.height) / 2),
  );
  screenshotHistoryWindow.show();
  screenshotHistoryWindow.focus();
  screenshotHistoryWindow.webContents.send('screenshot:history-refresh');
}

function createPinWindowShell() {
  const pinWindow = new BrowserWindow({
    width: 1, height: 1, show: false, frame: false, transparent: true,
    resizable: true, movable: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  pinWindow.__pinRendererReady = false;
  pinWindow.__pinEntryId = null;
  pinWindow.__pendingPinPayload = null;
  pinWindow.setAlwaysOnTop(true, 'screen-saver');
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) pinWindow.loadURL(`${devUrl}/pin.html`);
  else pinWindow.loadFile(path.join(__dirname, '..', 'dist', 'client', 'pin.html'));
  pinWindow.on('closed', () => {
    if (pinWindow.__pinEntryId) pinWindows.delete(pinWindow.__pinEntryId);
    if (warmPinWindow === pinWindow) warmPinWindow = null;
  });
  return pinWindow;
}

function ensureWarmPinWindow() {
  if (warmPinWindow && !warmPinWindow.isDestroyed()) return warmPinWindow;
  warmPinWindow = createPinWindowShell();
  return warmPinWindow;
}

function acquirePinWindow() {
  const pinWindow = warmPinWindow && !warmPinWindow.isDestroyed() ? warmPinWindow : createPinWindowShell();
  if (warmPinWindow === pinWindow) warmPinWindow = null;
  setTimeout(() => ensureWarmPinWindow(), 0);
  return pinWindow;
}

function sendPendingPin(pinWindow) {
  if (!pinWindow?.__pinRendererReady || !pinWindow.__pendingPinPayload || pinWindow.isDestroyed()) return;
  const payload = pinWindow.__pendingPinPayload;
  pinWindow.__pendingPinPayload = null;
  pinWindow.webContents.send('pin:show', payload);
}

function revealPinWindow(pinWindow, id) {
  if (!pinWindow || pinWindow.isDestroyed() || pinWindow.__pinEntryId !== id || pinWindow.isVisible()) return;
  pinWindow.show();
  traceScreenshotTiming('pin-window-shown');
  pinWindow.setAlwaysOnTop(true, 'screen-saver');
  pinWindow.moveTop();
  pinWindow.focus();
  setTimeout(() => {
    if (pinWindow.isDestroyed()) return;
    pinWindow.setAlwaysOnTop(true, 'screen-saver');
    pinWindow.moveTop();
  }, 80);
}

function pinImage(pinWindow) {
  const image = imageFromPinSource({
    bytes: pinWindow?.__pinImageBuffer,
    imagePath: pinWindow?.__pinImagePath,
  });
  return image.isEmpty() ? null : image;
}

function pinEntryPayload(pinWindow, imageBytes, size) {
  const entry = state.entries.find((item) => item.id === pinWindow.__pinEntryId && item.type === 'image');
  return entry ? {
    id: entry.id,
    entry: {
      ...entry,
      width: size.width,
      height: size.height,
      content: `${size.width} × ${size.height} · PNG`,
      imagePath: undefined,
      imageBytes,
    },
  } : null;
}

function updatePinImage(pinWindow, source, options = {}) {
  if (!pinWindow || pinWindow.isDestroyed()) return { success: false, message: '贴图已关闭' };
  const image = imageFromPinSource(source);
  if (image.isEmpty()) return { success: false, message: '图片变换结果无效' };
  const size = image.getSize();
  const ratio = size.width / size.height;
  const bounds = pinWindow.getContentBounds();
  const nextBounds = resetPinBounds(bounds, bounds.width * bounds.height, ratio);
  pinWindow.__pinImageBuffer = Buffer.isBuffer(source?.bytes) && source.bytes.length ? source.bytes : image.toPNG();
  pinWindow.__pinImagePath = null;
  pinWindow.__pinImageSize = size;
  // The area-preserving reset size becomes the new 100% zoom reference.
  pinWindow.__pinBaseArea = nextBounds.width * nextBounds.height;
  pinWindow.__pinBaseWidth = nextBounds.width;
  pinWindow.__pinBaseHeight = nextBounds.height;
  pinOcrCache.delete(pinWindow.__pinEntryId);
  pinWindow.setContentBounds(nextBounds);
  pinWindow.setAspectRatio(ratio);
  pinWindow.setAlwaysOnTop(true, 'screen-saver');
  pinWindow.moveTop();
  if (options.notifyRenderer) {
    const payload = pinEntryPayload(pinWindow, pinWindow.__pinImageBuffer, size);
    if (payload) pinWindow.webContents.send('pin:show', payload);
  }
  return { success: true, imageBytes: pinWindow.__pinImageBuffer, size, bounds: nextBounds };
}

function zoomPinWindow(pinWindow, payload = {}) {
  if (!pinWindow || pinWindow.isDestroyed()) return { success: false, message: '贴图已关闭' };
  const size = pinWindow.__pinImageSize;
  const ratio = size?.width > 0 && size?.height > 0 ? size.width / size.height : undefined;
  const bounds = pinWindow.getContentBounds();
  const nextBounds = payload.reset
    ? resetPinBounds(bounds, pinWindow.__pinBaseArea, ratio)
    : zoomPinBounds(bounds, { x: payload.clientX, y: payload.clientY }, Number(payload.deltaY), ratio);
  pinWindow.setContentBounds(nextBounds);
  pinWindow.setAlwaysOnTop(true, 'screen-saver');
  pinWindow.moveTop();
  // 100% is the size the pin was created at (or reset to after a transform),
  // not the pre-zoom size, so the HUD keeps showing absolute zoom.
  const baseWidth = Number(pinWindow.__pinBaseWidth);
  const scale = baseWidth > 0 ? nextBounds.width / baseWidth : 1;
  return { success: true, bounds: nextBounds, scale: Math.round(scale * 100) / 100 };
}

// Ctrl+wheel opacity for desktop pins, kept session-local like the zoom.
function setPinWindowOpacity(pinWindow, requested) {
  if (!pinWindow || pinWindow.isDestroyed()) return { success: false, message: '贴图已关闭' };
  const opacity = Math.min(1, Math.max(0.15, Number(requested)));
  if (!Number.isFinite(opacity)) return { success: false, message: '不透明度无效' };
  pinWindow.setOpacity(opacity);
  pinWindow.__pinOpacity = opacity;
  return { success: true, opacity };
}

function notifyPinOperation(pinWindow, result) {
  if (pinWindow && !pinWindow.isDestroyed()) pinWindow.webContents.send('pin:operation-result', result);
}

async function savePinImageToFile(pinWindow) {
  const image = pinImage(pinWindow);
  if (!image) return notifyPinOperation(pinWindow, { success: false, message: '贴图图片已不存在' });
  const entry = state.entries.find((item) => item.id === pinWindow.__pinEntryId);
  const baseName = String(entry?.title || `贴图-${Date.now()}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '贴图';
  const result = await dialog.showSaveDialog(pinWindow, {
    title: '保存固定截图',
    defaultPath: path.join(app.getPath('pictures'), `${baseName}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return;
  try {
    await fs.promises.writeFile(result.filePath, image.toPNG());
    notifyPinOperation(pinWindow, { success: true, message: `已保存到 ${path.basename(result.filePath)}` });
  } catch (error) {
    notifyPinOperation(pinWindow, { success: false, message: `保存失败：${error.message}` });
  }
}

function editPinImage(pinWindow) {
  const image = pinImage(pinWindow);
  if (!image) return notifyPinOperation(pinWindow, { success: false, message: '贴图图片已不存在' });
  const id = pinWindow.__pinEntryId;
  const size = image.getSize();
  const imageBounds = pinWindow.getContentBounds();
  const display = screen.getDisplayMatching(imageBounds);
  const shadowMargin = 30;
  const editorBounds = {
    x: imageBounds.x - shadowMargin,
    y: imageBounds.y - shadowMargin,
    width: imageBounds.width + shadowMargin * 2,
    height: imageBounds.height + shadowMargin * 2,
  };
  currentCapture = { editPinId: id, display, sourceSize: size };
  pinWindow.hide();
  openScreenshotEditor(display, { imageBytes: pinWindow.__pinImageBuffer || image.toPNG() }, editorBounds, {
    x: 0, y: 0, width: size.width, height: size.height,
  }, {
    editPinId: id,
    followSelection: false,
    initialTool: 'pen',
    contentInset: { left: shadowMargin, top: shadowMargin, right: shadowMargin, bottom: shadowMargin },
  });
}

function closeScreenshotEditorTask() {
  const editPinId = currentCapture?.editPinId;
  screenshotWindow?.hide();
  if (!editPinId) return;
  currentCapture = null;
  const pinWindow = pinWindows.get(editPinId);
  if (pinWindow && !pinWindow.isDestroyed()) revealPinWindow(pinWindow, editPinId);
}

function showPinContextMenu(event, payload) {
  const id = payload?.id;
  const pinWindow = pinWindows.get(id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) return;
  const sendCommand = (command) => {
    if (!pinWindow.isDestroyed()) pinWindow.webContents.send('pin:menu-command', command);
  };
  const bounds = pinWindow.getContentBounds();
  const centerZoom = (deltaY) => zoomPinWindow(pinWindow, { deltaY, clientX: bounds.width / 2, clientY: bounds.height / 2 });
  const template = [];
  if (payload?.hasSelection) {
    template.push(
      { label: '复制所选文字', click: () => sendCommand('copy-selection') },
      { label: '退出选字', click: () => sendCommand('finish-text-selection') },
      { type: 'separator' },
    );
  }
  template.push(
    { label: '保存到本地…', click: () => void savePinImageToFile(pinWindow) },
    { label: '再次涂鸦标记', click: () => editPinImage(pinWindow) },
    { type: 'separator' },
    { label: '向左旋转', click: () => sendCommand('rotate-left') },
    { label: '向右旋转', click: () => sendCommand('rotate-right') },
    { label: '水平翻转（镜像）', click: () => sendCommand('flip-horizontal') },
    { label: '垂直翻转（镜像）', click: () => sendCommand('flip-vertical') },
    { type: 'separator' },
    { label: '缩放', submenu: [
      { label: '放大', click: () => centerZoom(-100) },
      { label: '缩小', click: () => centerZoom(100) },
      { label: '恢复初始大小', click: () => zoomPinWindow(pinWindow, { reset: true }) },
    ] },
    { label: '不透明度', submenu: [1, 0.8, 0.6, 0.4, 0.2].map((value) => ({
      label: `${Math.round(value * 100)}%`,
      type: 'radio',
      checked: Math.abs((Number.isFinite(pinWindow.__pinOpacity) ? pinWindow.__pinOpacity : 1) - value) < 0.001,
      // Routed through the renderer so its opacity state stays the single
      // source of truth for later Ctrl+wheel steps.
      click: () => sendCommand(`set-opacity:${value}`),
    })) },
    { type: 'separator' },
    { label: '关闭贴图', click: () => pinWindow.destroy() },
  );
  Menu.buildFromTemplate(template).popup({ window: pinWindow });
}

function openPinWindow(entry, options = {}) {
  if (!entry || entry.type !== 'image') return { success: false, message: '截图不存在' };
  if (pinWindows.has(entry.id)) {
    const existing = pinWindows.get(entry.id);
    existing.setAlwaysOnTop(true, 'screen-saver');
    existing.show();
    existing.moveTop();
    existing.focus();
    return { success: true };
  }
  // Prefer PNG bytes that are already in hand (renderer-provided or the
  // stored image file); avoid a decode + base64 re-encode round trip.
  const imageBytes = (Buffer.isBuffer(options.imageBytes) && options.imageBytes.length)
    ? options.imageBytes
    : safeReadImageFile(entry.imagePath);
  const image = options.image && !options.image.isEmpty?.()
    ? options.image
    : imageFromPinSource({ bytes: imageBytes || undefined, imagePath: entry.imagePath });
  if (image.isEmpty()) return { success: false, message: '截图文件已不存在' };
  const finalBytes = imageBytes || image.toPNG();
  const size = image.getSize();
  const exactBounds = options.bounds && options.bounds.width > 0 && options.bounds.height > 0 ? options.bounds : null;
  const maxWidth = 520;
  const maxHeight = 420;
  const ratio = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  const contentWidth = exactBounds ? Math.round(exactBounds.width) : Math.max(1, Math.round(size.width * ratio));
  const contentHeight = exactBounds ? Math.round(exactBounds.height) : Math.max(1, Math.round(size.height * ratio));
  const contentBounds = exactBounds ? {
    x: Math.round(exactBounds.x), y: Math.round(exactBounds.y),
    width: contentWidth, height: contentHeight,
  } : null;
  const pinWindow = acquirePinWindow();
  const targetBounds = contentBounds || (() => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return {
      x: Math.round(display.workArea.x + (display.workArea.width - contentWidth) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - contentHeight) / 2),
      width: contentWidth,
      height: contentHeight,
    };
  })();
  pinWindow.__pinEntryId = entry.id;
  pinWindow.__pinImageBuffer = finalBytes;
  pinWindow.__pinImagePath = entry.imagePath;
  pinWindow.__pinImageSize = size;
  pinWindow.__pinBaseArea = targetBounds.width * targetBounds.height;
  pinWindow.__pinBaseWidth = targetBounds.width;
  pinWindow.__pinBaseHeight = targetBounds.height;
  // The warm window may carry a previous pin's faded state.
  pinWindow.setOpacity(1);
  pinWindow.__pinOpacity = 1;
  pinWindow.__pendingPinPayload = {
    id: entry.id,
    entry: { ...entry, imagePath: undefined, imageBytes: finalBytes },
  };
  pinWindow.setContentBounds(targetBounds);
  pinWindow.setAspectRatio(size.width / size.height);
  pinWindow.setAlwaysOnTop(true, 'screen-saver');
  pinWindows.set(entry.id, pinWindow);
  sendPendingPin(pinWindow);
  setTimeout(() => revealPinWindow(pinWindow, entry.id), 180);
  return { success: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 520,
    minWidth: 440,
    minHeight: 480,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'client', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('blur', () => {
    if (mainWindow?.isVisible() && !mainWindow.webContents.isDevToolsOpened()) mainWindow.hide();
  });
  mainWindow.on('hide', () => shortcutHold.commit());
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyUp') return;
    for (const key of shortcutKeyGroups(input.key)?.flat() || []) shortcutHold.keyUp(key);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    showWindow();
    broadcast();
  });
}

function createCaptureWindow() {
  captureWindow = new BrowserWindow({
    width: 360,
    height: 96,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  captureWindow.setAlwaysOnTop(true, 'pop-up-menu');
  captureWindow.setIgnoreMouseEvents(true);
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) captureWindow.loadURL(`${devUrl}/capture.html`);
  else captureWindow.loadFile(path.join(__dirname, '..', 'dist', 'client', 'capture.html'));
}

ipcMain.handle('clipboard:get-state', () => publicState());
ipcMain.handle('clipboard:paste-entry', async (_event, id) => {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return { success: false, message: '这条内容已不存在' };
  try {
    const targetSource = lastExternalSource;
    await writeEntryToClipboard(entry);
    mainWindow.hide();
    sendPasteKeystroke(previousWindowHandle, targetSource);
    previousWindowHandle = null;
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});
ipcMain.handle('clipboard:toggle-pin', (_event, id) => {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return { success: false, message: '这条内容已不存在' };
  entry.pinned = !entry.pinned;
  writeStoreAsync();
  broadcastDelta({ updatedEntry: publicEntry(entry) });
  return { success: true };
});
ipcMain.handle('clipboard:delete-entry', (_event, id) => {
  const pinWindow = pinWindows.get(id);
  if (pinWindow && !pinWindow.isDestroyed()) pinWindow.destroy();
  pinOcrCache.delete(id);
  const removed = state.entries.find((item) => item.id === id);
  state.entries = state.entries.filter((item) => item.id !== id);
  if (removed?.imagePath) thumbnailCache.delete(removed.imagePath);
  writeStoreAsync();
  scheduleImageGc();
  broadcastDelta({ removedIds: [id] });
  return { success: true };
});
ipcMain.handle('clipboard:create-entry', (_event, payload) => {
  if (payload?.type === 'image') {
    const entry = addImage(clipboard.readImage(), { custom: true, pinned: true, title: payload.title });
    return entry ? { success: true } : { success: false, message: '当前剪贴板里没有图片' };
  }
  const entry = addText(payload?.content || '', {
    custom: true,
    pinned: true,
    title: payload?.title,
    type: payload?.type || 'text',
  });
  return entry ? { success: true } : { success: false, message: '请输入要保存的内容' };
});
ipcMain.handle('window:set-mode', async (_event, mode) => {
  const target = mainWindow;
  if (!target || target.isDestroyed()) return { success: false };
  const revision = ++mainWindowModeRevision;
  // rAF runs before paint; flushing Chromium's current surface ensures the
  // destination page replaces the wheel before native bounds are committed.
  try {
    await target.webContents.capturePage();
  } catch {
    return { success: false };
  }
  if (target !== mainWindow || target.isDestroyed() || revision !== mainWindowModeRevision) return { success: false };
  setMainWindowMode(mode === 'clipboard' ? 'clipboard' : 'launcher');
  return { success: true };
});
ipcMain.handle('launcher:activate', async (_event, { sessionId = null } = {}) => {
  if (sessionId !== null && (!shortcutHold.isPending() || shortcutHold.sessionId() !== sessionId)) return { success: false };
  if (shortcutHold.isPending()) {
    if (sessionId !== shortcutHold.sessionId()) return { success: false };
    // Recheck native key ownership before accepting a click or pointer release.
    // The renderer's key-up event may be in transit or focus may have changed.
    if (!await shortcutHold.check()) return { success: false };
    shortcutHold.commit();
  }
  return { success: true };
});
ipcMain.on('window:shortcut-release', () => shortcutHold.release());
ipcMain.handle('clipboard:update-shortcut', (_event, accelerator) => registerAppShortcut(accelerator));
ipcMain.handle('clipboard:write-text', (_event, text) => {
  const content = String(text ?? '');
  clipboard.writeText(content);
  return { success: true };
});
ipcMain.handle('screenshot:update-shortcuts', (_event, shortcuts) => registerScreenshotShortcuts(shortcuts));
ipcMain.handle('shortcuts:set-recording', (_event, active) => setShortcutRecording(active));
ipcMain.handle('shortcuts:update-all', (_event, payload) => updateAllShortcuts(payload?.shortcut, payload?.screenshotShortcuts));
ipcMain.handle('clipboard:update-preferences', (_event, preferences) => {
  state.preferences = mergePreferences({ ...state.preferences, ...(preferences || {}) });
  trimHistory();
  writeStoreAsync();
  broadcast({ notice: '复制记录设置已更新' });
  return { success: true, preferences: state.preferences };
});
ipcMain.handle('screenshot:save', (_event, payload) => {
  try {
    traceScreenshotTiming('save-ipc-start');
    // Renderer sends raw PNG bytes when possible; dataUrl stays as a fallback.
    const imageBytes = coerceImageBytes(payload?.imageBytes);
    const dataUrl = String(payload?.dataUrl || '');
    const image = imageBytes ? nativeImage.createFromBuffer(imageBytes) : nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return { success: false, message: '截图数据无效' };
    if (payload?.editPinId) {
      const editPinId = String(payload.editPinId);
      const pinWindow = pinWindows.get(editPinId);
      if (!pinWindow || pinWindow.isDestroyed() || currentCapture?.editPinId !== editPinId) {
        return { success: false, message: '要标记的贴图已关闭' };
      }
      const updated = updatePinImage(pinWindow, { bytes: imageBytes, dataUrl }, { notifyRenderer: true });
      if (!updated.success) return updated;
      if (payload?.copy !== false) clipboard.writeImage(image);
      screenshotWindow?.hide();
      currentCapture = null;
      pinWindows.set(editPinId, pinWindow);
      revealPinWindow(pinWindow, editPinId);
      return { success: true, id: editPinId, editedPin: true };
    }
    const pngMarker = 'data:image/png;base64,';
    const pngBuffer = imageBytes || (dataUrl.startsWith(pngMarker) ? Buffer.from(dataUrl.slice(pngMarker.length), 'base64') : undefined);
    const entry = addImage(image, {
      formats: ['image/png'], origin: 'screenshot', force: true, pngBuffer,
    });
    traceScreenshotTiming('save-history-queued');
    if (!entry) return { success: false, message: '截图没有变化' };
    if (payload?.copy !== false) clipboard.writeImage(image);
    if (payload?.pin) {
      const exactBounds = currentCapture ? capturePinBounds(currentCapture.display.bounds, currentCapture.sourceSize, payload?.crop) : null;
      screenshotWindow?.hide();
      const pinResult = openPinWindow(entry, { bounds: exactBounds, image, imageBytes: pngBuffer });
      traceScreenshotTiming('pin-window-prepared');
      if (!pinResult?.success) return pinResult;
    } else {
      screenshotWindow?.hide();
    }
    return { success: true, id: entry.id };
  } catch (error) {
    return { success: false, message: error.message };
  }
});
ipcMain.handle('screenshot:reselect', () => {
  if (!screenshotWindow || screenshotWindow.isDestroyed() || !currentCapture) return { success: false };
  const { display, imagePayload } = currentCapture;
  screenshotWindow.setBounds(display.bounds);
  screenshotWindow.webContents.send('screenshot:begin', { ...imagePayload, initialSelection: null });
  screenshotWindow.focus();
  return { success: true };
});
ipcMain.handle('screenshot:get-history', () => ({
  // Thumbnails only; the history window fetches each full image on demand.
  entries: state.entries.filter(isScreenshotEntry).map((entry) => publicEntry(entry)),
  pinnedIds: [...pinWindows.keys()],
  historyPinShortcut: state.screenshotShortcuts.historyPin,
}));
ipcMain.handle('screenshot:open-history', () => {
  showScreenshotHistory();
  return { success: true };
});
ipcMain.handle('screenshot:get-entry', (_event, id) => {
  const entry = state.entries.find((item) => item.id === id && item.type === 'image');
  if (!entry) return null;
  return { ...publicEntry(entry), imageBytes: safeReadImageFile(entry.imagePath) };
});
ipcMain.handle('screenshot:pin', (_event, id) => {
  const entry = state.entries.find((item) => item.id === id && item.type === 'image');
  return openPinWindow(entry);
});
ipcMain.handle('screenshot:unpin', (event, id) => {
  const mappedWindow = pinWindows.get(id);
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const senderIsPin = senderWindow && [...pinWindows.values()].includes(senderWindow);
  const pinWindow = mappedWindow && !mappedWindow.isDestroyed() ? mappedWindow : (senderIsPin ? senderWindow : null);
  if (pinWindow && !pinWindow.isDestroyed()) pinWindow.destroy();
  return { success: true, closed: Boolean(pinWindow) };
});
ipcMain.on('pin:close-current', (event) => {
  const pinWindow = BrowserWindow.fromWebContents(event.sender);
  if (!pinWindow || pinWindow.isDestroyed() || !pinWindow.__pinEntryId) return;
  pinWindow.destroy();
});
ipcMain.on('screenshot:show-pin-menu', showPinContextMenu);
ipcMain.handle('screenshot:update-pin-image', (event, payload) => {
  const pinWindow = pinWindows.get(payload?.id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) return { success: false, message: '贴图已关闭' };
  // The renderer sends an ArrayBuffer (Blob#arrayBuffer), which structured
  // clone delivers as-is — not as a Uint8Array — so normalize both shapes.
  const bytes = coerceImageBytes(payload?.imageBytes);
  return updatePinImage(pinWindow, { bytes, dataUrl: payload?.dataUrl });
});
ipcMain.handle('screenshot:recognize-pin-text', async (event, id) => {
  const pinWindow = pinWindows.get(id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) {
    return { success: false, message: '贴图已关闭' };
  }
  try {
    return await pinOcrCache.get(id, {
      bytes: pinWindow.__pinImageBuffer || null,
      imagePath: pinWindow.__pinImagePath,
    });
  } catch (error) {
    return { success: false, message: `文字识别失败：${error.message}` };
  }
});
ipcMain.handle('screenshot:copy-pin-text', (event, payload) => {
  const id = payload?.id;
  const pinWindow = pinWindows.get(id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) {
    return { success: false, message: '贴图已关闭' };
  }
  const text = String(payload?.text || '').trim();
  if (!text) return { success: false, message: '请先选择要复制的文字' };
  clipboard.writeText(text.slice(0, 100000));
  return { success: true, charCount: Math.min(text.length, 100000) };
});
ipcMain.handle('screenshot:zoom-pin', (event, payload) => {
  const pinWindow = pinWindows.get(payload?.id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) return { success: false, message: '贴图已关闭' };
  return zoomPinWindow(pinWindow, payload);
});
ipcMain.handle('screenshot:set-pin-opacity', (event, payload) => {
  const pinWindow = pinWindows.get(payload?.id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) return { success: false, message: '贴图已关闭' };
  return setPinWindowOpacity(pinWindow, payload?.opacity);
});
ipcMain.on('screenshot:move-pin', (event, payload) => {
  const pinWindow = pinWindows.get(payload?.id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) return;
  const bounds = pinWindow.getContentBounds();
  const x = Number(payload?.x);
  const y = Number(payload?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  pinWindow.setContentBounds({ ...bounds, x: Math.round(x), y: Math.round(y) });
  pinWindow.moveTop();
});
ipcMain.on('pin:renderer-ready', (event) => {
  const pinWindow = BrowserWindow.fromWebContents(event.sender);
  if (!pinWindow || pinWindow.isDestroyed()) return;
  pinWindow.__pinRendererReady = true;
  sendPendingPin(pinWindow);
});
ipcMain.on('pin:image-ready', (event, id) => {
  const pinWindow = BrowserWindow.fromWebContents(event.sender);
  if (!pinWindow || pinWindow.isDestroyed() || pinWindow.__pinEntryId !== id) return;
  traceScreenshotTiming('pin-image-ready');
  revealPinWindow(pinWindow, id);
  const imageBytes = pinWindow.__pinImageBuffer || null;
  const imagePath = pinWindow.__pinImagePath;
  setTimeout(() => {
    if (pinWindow.isDestroyed() || pinWindows.get(id) !== pinWindow) return;
    void pinOcrCache.get(id, { bytes: imageBytes, imagePath }).catch(() => {});
  }, 120);
});
ipcMain.on('screenshot:editor-close', closeScreenshotEditorTask);
ipcMain.on('screenshot:renderer-ready', () => {
  screenshotRendererReady = true;
  if (!screenshotWindow || screenshotWindow.isDestroyed() || !pendingScreenshotPayload) return;
  screenshotWindow.webContents.send('screenshot:begin', pendingScreenshotPayload);
  pendingScreenshotPayload = null;
});
ipcMain.on('screenshot:ready', () => {
  if (!screenshotWindow || screenshotWindow.isDestroyed()) return;
  setScreenshotPinShortcut(true);
  screenshotWindow.show();
  traceScreenshotTiming('capture-window-shown');
  screenshotWindow.focus();
});
ipcMain.on('screenshot:history-close', () => screenshotHistoryWindow?.hide());
ipcMain.on('window:hide', () => mainWindow?.hide());
ipcMain.on('app:quit', () => {
  quitApplication();
});

app.on('second-instance', showWindow);

app.on('before-quit', (event) => {
  if (shutdownReady) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  app.isQuitting = true;
  clearInterval(pollTimer);
  // Drain disk work before the synchronous final store flush. Otherwise an
  // old async rename can overwrite it, or a referenced PNG can be incomplete.
  void (async () => {
    while (pendingImageWrites.size) await Promise.allSettled([...pendingImageWrites]);
    await storeWriteQueue;
    shutdownReady = true;
    app.quit();
  })();
});

if (hasSingleInstanceLock) app.whenReady().then(() => {
  app.setAppUserModelId('com.local.pasty');
  loadStore();
  windowsBridge.start();
  refreshSourceContext();
  createWindow();
  createCaptureWindow();
  createScreenshotWindow();
  createTray();
  ensureWarmPinWindow();
  setTimeout(() => { void prewarmDesktopCapture(); }, 350);
  registerAppShortcut(state.shortcut || DEFAULT_SHORTCUT, { persist: false });
  registerScreenshotShortcuts(state.screenshotShortcuts, { persist: false });
  trimHistory();
  scheduleImageGc(1500);
  inspectClipboard();
  pollTimer = setInterval(() => { void pollClipboard(); }, POLL_INTERVAL);
});

app.on('will-quit', () => {
  shortcutHold.stop();
  clearInterval(pollTimer);
  writeStore();
  windowsBridge.stop();
  pinOcrCache.clear();
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {});
