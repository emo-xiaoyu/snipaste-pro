const { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_PREFERENCES,
  capturePinBounds,
  classifyText,
  defaultCaptureRegion,
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
const { createOcrService } = require('./ocr-core.cjs');
const { createPaddleOcrService } = require('./paddle-ocr-core.cjs');
const { createPinOcrCache } = require('./pin-ocr-cache.cjs');
const { WindowsBridge } = require('./windows-bridge.cjs');

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
let captureWindow;
let screenshotWindow;
let screenshotHistoryWindow;
let warmPinWindow;
let tray;
const pinWindows = new Map();
let pollTimer;
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
const thumbnailCache = new Map();
const windowsBridge = new WindowsBridge();
let ocrService;
let paddleOcrService;

function getOcrService() {
  if (!ocrService) {
    ocrService = createOcrService({ dataDir: path.join(app.getPath('userData'), 'ocr') });
  }
  return ocrService;
}

function getPaddleOcrService() {
  if (!paddleOcrService) paddleOcrService = createPaddleOcrService();
  return paddleOcrService;
}

async function recognizePinImage(input) {
  const dataUrl = typeof input === 'string' ? input : input?.dataUrl;
  const persistedPath = typeof input === 'object' && input?.imagePath && fs.existsSync(input.imagePath)
    ? input.imagePath
    : null;
  const image = persistedPath ? nativeImage.createFromPath(persistedPath) : nativeImage.createFromDataURL(dataUrl || '');
  if (image.isEmpty()) throw new Error('无法读取贴图内容');
  const sourceSize = image.getSize();
  let temporaryPath;
  let paddlePath = persistedPath;
  if (!paddlePath) {
    temporaryPath = path.join(app.getPath('temp'), `pasty-ocr-${crypto.randomUUID()}.png`);
    await fs.promises.writeFile(temporaryPath, image.toPNG());
    paddlePath = temporaryPath;
  }
  try {
    const paddleResult = await getPaddleOcrService().recognize(paddlePath);
    if (paddleResult.items.length) {
      return {
        success: true,
        engine: 'paddle',
        charCount: paddleResult.text.length,
        confidence: paddleResult.confidence,
        imageSize: sourceSize,
        items: paddleResult.items,
      };
    }
  } catch (error) {
    console.warn('Paddle OCR unavailable, falling back to Tesseract:', error.message);
  } finally {
    if (temporaryPath) void fs.promises.unlink(temporaryPath).catch(() => {});
  }
  const longestEdge = Math.max(sourceSize.width, sourceSize.height);
  const upscale = Math.min(4, Math.max(1, 2200 / longestEdge));
  const ocrImage = upscale > 1
    ? image.resize({
        width: Math.round(sourceSize.width * upscale),
        height: Math.round(sourceSize.height * upscale),
        quality: 'best',
      })
    : image;
  const result = await getOcrService().recognize(ocrImage.toPNG());
  if (!result.items.length) throw new Error('没有识别到可选择的文字或数字');
  return {
      success: true,
      engine: 'tesseract',
    charCount: result.text.length,
    confidence: result.confidence,
    imageSize: ocrImage.getSize(),
    items: result.items,
  };
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
  return fs.promises.writeFile(tempPath, snapshot, 'utf8').then(() => {
    if (revision !== storeRevision) {
      return fs.promises.unlink(tempPath).catch(() => {});
    }
    fs.renameSync(tempPath, storePath);
    return undefined;
  }).catch((error) => {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    console.warn('Could not persist clipboard store asynchronously:', error.message);
  });
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

function fullImageDataUrl(entry) {
  if (entry?.type !== 'image' || !entry.imagePath || !fs.existsSync(entry.imagePath)) return null;
  try { return nativeImage.createFromPath(entry.imagePath).toDataURL(); } catch { return null; }
}

function trimHistory() {
  const durable = state.entries.filter((entry) => entry.pinned || entry.custom);
  const limit = state.preferences?.historyLimit || HISTORY_LIMIT;
  const transient = state.entries.filter((entry) => !entry.pinned && !entry.custom).slice(0, limit);
  const keep = new Set([...durable, ...transient].map((entry) => entry.id));
  state.entries = state.entries.filter((entry) => keep.has(entry.id));
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
  trimHistory();
  writeStore();
  broadcast({ capturedEntry: publicEntry(existing) });
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

function broadcast(extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('clipboard:state-changed', publicState(extra));
  }
}

function addText(content, options = {}) {
  const normalized = normalizeText(content);
  if (!normalized) return null;
  const html = state.preferences.captureRichText ? String(options.html || '') : '';
  const fingerprint = textFingerprint(normalized, html);
  if (!options.custom && fingerprint !== lastFingerprint) suppressFingerprint = '';
  if (!options.custom && (fingerprint === lastFingerprint || fingerprint === suppressFingerprint)) return null;
  const sensitive = detectSensitive(normalized);
  if (!options.custom && sensitive && state.preferences.protectSensitive) {
    lastFingerprint = fingerprint;
    broadcast({ notice: `检测到${sensitive.label}，已跳过记录` });
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
  trimHistory();
  writeStore();
  broadcast({ capturedEntry: publicEntry(entry) });
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
  trimHistory();
  if (options.asyncWrite) {
    const imageWrite = needsImageWrite ? fs.promises.writeFile(imagePath, png) : Promise.resolve();
    imageWrite.then(() => writeStoreAsync()).then(() => {
      broadcast({ capturedEntry: publicEntry(entry) });
      showCaptureToast(entry);
    }).catch((error) => {
      console.warn('Could not persist screenshot image:', error.message);
      broadcast({ notice: '截图已固定，但本地历史写入失败' });
    });
  } else {
    if (needsImageWrite) fs.writeFileSync(imagePath, png);
    writeStore();
    broadcast({ capturedEntry: publicEntry(entry) });
    showCaptureToast(entry);
  }
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
  trimHistory();
  writeStore();
  broadcast({ capturedEntry: publicEntry(entry) });
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

function inspectClipboard() {
  try {
    if (state.preferences.trackSource) refreshSourceContext();
    const formats = clipboard.availableFormats();
    if (state.preferences.captureFiles) {
      const files = readFilePaths(formats);
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

function writeEntryToClipboard(entry) {
  if (entry.type === 'image') {
    if (!entry.imagePath || !fs.existsSync(entry.imagePath)) throw new Error('图片文件已不存在');
    const image = nativeImage.createFromPath(entry.imagePath);
    suppressFingerprint = entry.fingerprint;
    clipboard.writeImage(image);
  } else if (entry.type === 'file') {
    suppressFingerprint = entry.fingerprint;
    clipboard.writeText((entry.files || []).join('\n') || entry.content || '');
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
    broadcast({ notice: '内容已复制；自动粘贴暂时不可用。' });
  });
}

function positionWindow() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { x, y, width, height } = display.workArea;
  const bounds = mainWindow.getBounds();
  mainWindow.setPosition(
    Math.round(x + (width - bounds.width) / 2),
    Math.round(y + Math.max(36, (height - bounds.height) * 0.28)),
    false,
  );
}

function showWindow(options = {}) {
  if (!mainWindow) return;
  if (options.fromShortcut && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  if (options.fromShortcut) {
    windowsBridge.foreground().then((source) => {
      const normalized = normalizeSource(source);
      if (normalized) {
        lastExternalSource = normalized;
        previousWindowHandle = normalized.handle;
      } else {
        previousWindowHandle = lastExternalSource?.handle || null;
      }
      revealWindow();
    }).catch(() => {
      previousWindowHandle = lastExternalSource?.handle || null;
      revealWindow();
    });
    return;
  }
  revealWindow();
}

function revealWindow() {
  positionWindow();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('window:focus-search');
  setTimeout(() => mainWindow?.webContents.send('window:focus-search'), 80);
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
      click: () => captureCurrentDisplay().catch((error) => broadcast({ notice: error.message })),
    },
    {
      label: '快速截图并固定',
      click: () => captureCurrentDisplay({ pinImmediately: true }).catch((error) => broadcast({ notice: error.message })),
    },
    { label: '截图历史', click: () => showScreenshotHistory() },
    { type: 'separator' },
    { label: '退出 Pasty', click: quitApplication },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function registerAppShortcut(nextShortcut, options = {}) {
  const previous = state.shortcut || DEFAULT_SHORTCUT;
  globalShortcut.unregister(previous);
  const success = globalShortcut.register(nextShortcut, () => showWindow({ fromShortcut: true }));
  if (!success) {
    globalShortcut.register(previous, () => showWindow({ fromShortcut: true }));
    return { success: false, message: '快捷键已被其他应用占用' };
  }
  state.shortcut = nextShortcut;
  if (options.persist !== false) {
    writeStore();
    broadcast({ notice: `快捷键已更新为 ${nextShortcut}` });
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
  shortcutRecordingActive = Boolean(active);
  if (shortcutRecordingActive) unregisterConfigurableShortcuts();
  else restoreConfigurableShortcuts();
  return { success: true, active: shortcutRecordingActive };
}

function updateAllShortcuts(nextAppShortcut, nextScreenshotShortcuts) {
  const previousAppShortcut = state.shortcut || DEFAULT_SHORTCUT;
  const previousScreenshotShortcuts = { ...DEFAULT_SCREENSHOT_SHORTCUTS, ...state.screenshotShortcuts };
  const candidateAppShortcut = String(nextAppShortcut || '').trim();
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
  writeStore();
  broadcast({ notice: '快捷键已保存并生效' });
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
      captureCurrentDisplay().catch((error) => broadcast({ notice: error.message }));
    }],
    [shortcuts.quickPin, () => captureCurrentDisplay({ pinImmediately: true }).catch((error) => broadcast({ notice: error.message }))],
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
    writeStore();
    broadcast({ notice: '截图快捷键已更新' });
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
    const entry = addImage(cropped, { formats: ['image/png'], origin: 'screenshot', asyncWrite: true });
    if (!entry) return;
    clipboard.writeImage(cropped);
    openPinWindow(entry, { bounds: region, image: cropped, imageUrl: cropped.toDataURL() });
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
  const dataUrl = pinWindow?.__pinImageDataUrl || '';
  const image = dataUrl ? nativeImage.createFromDataURL(dataUrl) : nativeImage.createFromPath(pinWindow?.__pinImagePath || '');
  return image && !image.isEmpty() ? image : null;
}

function pinEntryPayload(pinWindow, imageUrl, size) {
  const entry = state.entries.find((item) => item.id === pinWindow.__pinEntryId && item.type === 'image');
  return entry ? {
    id: entry.id,
    entry: {
      ...entry,
      width: size.width,
      height: size.height,
      content: `${size.width} × ${size.height} · PNG`,
      imagePath: undefined,
      imageUrl,
    },
  } : null;
}

function updatePinImage(pinWindow, dataUrl, options = {}) {
  if (!pinWindow || pinWindow.isDestroyed()) return { success: false, message: '贴图已关闭' };
  const image = nativeImage.createFromDataURL(String(dataUrl || ''));
  if (image.isEmpty()) return { success: false, message: '图片变换结果无效' };
  const size = image.getSize();
  const ratio = size.width / size.height;
  const bounds = pinWindow.getContentBounds();
  const nextBounds = resetPinBounds(bounds, bounds.width * bounds.height, ratio);
  pinWindow.__pinImageDataUrl = image.toDataURL();
  pinWindow.__pinImagePath = null;
  pinWindow.__pinImageSize = size;
  pinOcrCache.delete(pinWindow.__pinEntryId);
  pinWindow.setContentBounds(nextBounds);
  pinWindow.setAspectRatio(ratio);
  pinWindow.setAlwaysOnTop(true, 'screen-saver');
  pinWindow.moveTop();
  if (options.notifyRenderer) {
    const payload = pinEntryPayload(pinWindow, pinWindow.__pinImageDataUrl, size);
    if (payload) pinWindow.webContents.send('pin:show', payload);
  }
  return { success: true, imageUrl: pinWindow.__pinImageDataUrl, size, bounds: nextBounds };
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
  return { success: true, bounds: nextBounds };
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
  openScreenshotEditor(display, pinWindow.__pinImageDataUrl || image.toDataURL(), editorBounds, {
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
  const image = options.image && !options.image.isEmpty?.() ? options.image : nativeImage.createFromPath(entry.imagePath);
  if (image.isEmpty()) return { success: false, message: '截图文件已不存在' };
  const size = image.getSize();
  const exactBounds = options.bounds && options.bounds.width > 0 && options.bounds.height > 0 ? options.bounds : null;
  const maxWidth = 520;
  const maxHeight = 420;
  const ratio = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  const contentWidth = exactBounds ? Math.round(exactBounds.width) : Math.max(180, Math.round(size.width * ratio));
  const contentHeight = exactBounds ? Math.round(exactBounds.height) : Math.max(120, Math.round(size.height * ratio));
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
  const pinImageUrl = options.imageUrl || fullImageDataUrl(entry);
  pinWindow.__pinEntryId = entry.id;
  pinWindow.__pinImageDataUrl = pinImageUrl;
  pinWindow.__pinImagePath = entry.imagePath;
  pinWindow.__pinImageSize = size;
  pinWindow.__pinBaseArea = targetBounds.width * targetBounds.height;
  pinWindow.__pendingPinPayload = {
    id: entry.id,
    entry: { ...entry, imagePath: undefined, imageUrl: pinImageUrl },
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
    width: 540,
    height: 720,
    minWidth: 440,
    minHeight: 560,
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
ipcMain.handle('clipboard:paste-entry', (_event, id) => {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return { success: false, message: '这条内容已不存在' };
  try {
    const targetSource = lastExternalSource;
    writeEntryToClipboard(entry);
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
  if (!entry) return publicState();
  entry.pinned = !entry.pinned;
  writeStore();
  broadcast();
  return publicState();
});
ipcMain.handle('clipboard:delete-entry', (_event, id) => {
  const pinWindow = pinWindows.get(id);
  if (pinWindow && !pinWindow.isDestroyed()) pinWindow.destroy();
  pinOcrCache.delete(id);
  state.entries = state.entries.filter((item) => item.id !== id);
  writeStore();
  broadcast();
  return publicState();
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
ipcMain.handle('clipboard:update-shortcut', (_event, accelerator) => registerAppShortcut(accelerator));
ipcMain.handle('screenshot:update-shortcuts', (_event, shortcuts) => registerScreenshotShortcuts(shortcuts));
ipcMain.handle('shortcuts:set-recording', (_event, active) => setShortcutRecording(active));
ipcMain.handle('shortcuts:update-all', (_event, payload) => updateAllShortcuts(payload?.shortcut, payload?.screenshotShortcuts));
ipcMain.handle('clipboard:update-preferences', (_event, preferences) => {
  state.preferences = mergePreferences({ ...state.preferences, ...(preferences || {}) });
  trimHistory();
  writeStore();
  broadcast({ notice: '复制记录设置已更新' });
  return publicState();
});
ipcMain.handle('screenshot:save', (_event, payload) => {
  try {
    traceScreenshotTiming('save-ipc-start');
    const dataUrl = String(payload?.dataUrl || '');
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return { success: false, message: '截图数据无效' };
    if (payload?.editPinId) {
      const editPinId = String(payload.editPinId);
      const pinWindow = pinWindows.get(editPinId);
      if (!pinWindow || pinWindow.isDestroyed() || currentCapture?.editPinId !== editPinId) {
        return { success: false, message: '要标记的贴图已关闭' };
      }
      const updated = updatePinImage(pinWindow, dataUrl, { notifyRenderer: true });
      if (!updated.success) return updated;
      if (payload?.copy !== false) clipboard.writeImage(image);
      screenshotWindow?.hide();
      currentCapture = null;
      pinWindows.set(editPinId, pinWindow);
      revealPinWindow(pinWindow, editPinId);
      return { success: true, id: editPinId, editedPin: true };
    }
    const pngMarker = 'data:image/png;base64,';
    const pngBuffer = dataUrl.startsWith(pngMarker) ? Buffer.from(dataUrl.slice(pngMarker.length), 'base64') : undefined;
    const entry = addImage(image, {
      formats: ['image/png'], origin: 'screenshot', force: true, asyncWrite: true, pngBuffer,
    });
    traceScreenshotTiming('save-history-queued');
    if (!entry) return { success: false, message: '截图没有变化' };
    if (payload?.copy !== false) clipboard.writeImage(image);
    if (payload?.pin) {
      const exactBounds = currentCapture ? capturePinBounds(currentCapture.display.bounds, currentCapture.sourceSize, payload?.crop) : null;
      screenshotWindow?.hide();
      const pinResult = openPinWindow(entry, { bounds: exactBounds, image, imageUrl: dataUrl });
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
  entries: state.entries.filter(isScreenshotEntry).map((entry) => ({ ...publicEntry(entry), imageUrl: fullImageDataUrl(entry) })),
  pinnedIds: [...pinWindows.keys()],
  historyPinShortcut: state.screenshotShortcuts.historyPin,
}));
ipcMain.handle('screenshot:get-entry', (_event, id) => {
  const entry = state.entries.find((item) => item.id === id && item.type === 'image');
  return entry ? { ...publicEntry(entry), imageUrl: fullImageDataUrl(entry) } : null;
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
  return updatePinImage(pinWindow, payload?.dataUrl);
});
ipcMain.handle('screenshot:recognize-pin-text', async (event, id) => {
  const pinWindow = pinWindows.get(id);
  if (!pinWindow || pinWindow.isDestroyed() || event.sender !== pinWindow.webContents) {
    return { success: false, message: '贴图已关闭' };
  }
  try {
    return await pinOcrCache.get(id, {
      dataUrl: pinWindow.__pinImageDataUrl || '',
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
  const imageDataUrl = pinWindow.__pinImageDataUrl || '';
  const imagePath = pinWindow.__pinImagePath;
  setTimeout(() => {
    if (pinWindow.isDestroyed() || pinWindows.get(id) !== pinWindow) return;
    void pinOcrCache.get(id, { dataUrl: imageDataUrl, imagePath }).catch(() => {});
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
  registerAppShortcut(state.shortcut || DEFAULT_SHORTCUT);
  registerScreenshotShortcuts(state.screenshotShortcuts, { persist: false });
  inspectClipboard();
  pollTimer = setInterval(inspectClipboard, POLL_INTERVAL);
});

app.on('will-quit', () => {
  clearInterval(pollTimer);
  writeStore();
  windowsBridge.stop();
  pinOcrCache.clear();
  paddleOcrService?.terminate();
  void ocrService?.terminate();
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
});

app.on('window-all-closed', () => {});
