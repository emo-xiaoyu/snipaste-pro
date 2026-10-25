// Reimplements window.clipboardAPI on top of Tauri's global invoke/event
// bridge, replacing electron/preload.cjs. Only activates when running inside
// the Tauri shell (__TAURI__ injected by withGlobalTauri); the plain-browser
// demo fallback in App.jsx keeps working otherwise.
//
// Binary payloads (screenshot PNG bytes) travel as base64 `imageBytesB64`
// fields in both directions; this adapter converts them to/from Uint8Array so
// the page code never sees the difference.

(function installTauriAdapter() {
  const tauri = window.__TAURI__;
  if (!tauri || window.clipboardAPI) return;

  const invoke = tauri.core.invoke;
  const listenEvent = tauri.event.listen;

  // Tauri's listen() resolves asynchronously. Commands that the main process
  // answers with a follow-up event (renderer-ready handshakes) must wait until
  // the listener registration actually landed, otherwise a payload emitted on
  // ready could beat the listener and be lost forever.
  const pendingListens = new Set();
  const waitForListens = () => (pendingListens.size ? Promise.all([...pendingListens]) : Promise.resolve());

  function onEvent(name, handler) {
    const registration = listenEvent(name, (event) => handler(event.payload));
    pendingListens.add(registration);
    registration.then(
      () => pendingListens.delete(registration),
      () => pendingListens.delete(registration),
    );
    let unlisten = null;
    let cancelled = false;
    registration.then((fn) => {
      unlisten = fn;
      if (cancelled) fn();
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }

  function u8ToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToU8(text) {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function toBytes(value) {
    if (!value) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return new Uint8Array(0);
  }

  // Recursively turn imageBytesB64 into imageBytes (Uint8Array).
  function decodeB64Fields(value) {
    if (Array.isArray(value)) {
      value.forEach(decodeB64Fields);
      return value;
    }
    if (value && typeof value === 'object') {
      if (typeof value.imageBytesB64 === 'string') {
        value.imageBytes = base64ToU8(value.imageBytesB64);
        delete value.imageBytesB64;
      }
      for (const key of Object.keys(value)) decodeB64Fields(value[key]);
    }
    return value;
  }

  // Pin opacity lives on the page (the adapter owns it so pin.jsx stays
  // untouched); a new pin payload resets it to fully opaque.
  onEvent('pin:set-opacity', (payload) => {
    const value = Number(payload?.opacity);
    if (Number.isFinite(value)) {
      document.documentElement.style.opacity = String(Math.max(0.15, Math.min(1, value)));
    }
  });
  onEvent('pin:show', () => {
    document.documentElement.style.opacity = '1';
  });

  window.clipboardAPI = {
    getState: () => invoke('get_state'),
    pasteEntry: (id) => invoke('paste_entry', { id }),
    togglePin: (id) => invoke('toggle_pin', { id }),
    deleteEntry: (id) => invoke('delete_entry', { id }),
    createEntry: (payload) => invoke('create_entry', { payload }),
    updateShortcut: (accelerator) => invoke('update_shortcut', { accelerator }),
    updatePreferences: (preferences) => invoke('update_preferences', { preferences }),
    updateScreenshotShortcuts: (shortcuts) => invoke('update_screenshot_shortcuts', { shortcuts }),
    setShortcutRecording: (active) => invoke('set_shortcut_recording', { active }),
    updateAllShortcuts: (shortcut, screenshotShortcuts) => invoke('update_all_shortcuts', { shortcut, screenshotShortcuts }),
    openScreenshotHistory: () => invoke('open_screenshot_history'),
    saveScreenshot: (payload) => invoke('save_screenshot', {
      payload: {
        pin: payload?.pin,
        copy: payload?.copy,
        crop: payload?.crop,
        editPinId: payload?.editPinId,
        imageBytesB64: u8ToBase64(toBytes(payload?.imageBytes)),
      },
    }),
    reselectScreenshot: () => invoke('reselect_screenshot'),
    getScreenshotHistory: () => invoke('get_screenshot_history'),
    getScreenshotEntry: (id) => invoke('get_screenshot_entry', { id }).then(decodeB64Fields),
    pinScreenshot: (id) => invoke('pin_screenshot', { id }),
    unpinScreenshot: (id) => invoke('unpin_screenshot', { id }),
    closeCurrentPin: () => invoke('close_current_pin'),
    showPinContextMenu: (id, options) => invoke('show_pin_menu', {
      id,
      hasSelection: Boolean(options?.hasSelection),
      textMode: Boolean(options?.textMode),
    }),
    updatePinImage: (id, imageBytes) => invoke('update_pin_image', {
      id,
      imageBytesB64: u8ToBase64(toBytes(imageBytes)),
    }).then(decodeB64Fields),
    recognizePinText: (id) => invoke('recognize_pin_text', { id }),
    copyPinText: (id, text) => invoke('copy_pin_text', { id, text }),
    writeClipboardText: (text) => invoke('write_clipboard_text', { text }),
    setWindowMode: (mode) => invoke('set_window_mode', { mode }),
    activateLauncher: (sessionId) => invoke('activate_launcher', { sessionId }),
    releaseLauncherShortcut: () => invoke('release_launcher_shortcut'),
    zoomPin: (id, payload) => invoke('zoom_pin', {
      id,
      deltaY: payload?.deltaY,
      clientX: payload?.clientX,
      clientY: payload?.clientY,
      reset: payload?.reset,
    }),
    setPinOpacity: (id, opacity) => invoke('set_pin_opacity', { id, opacity }),
    movePin: (id, payload) => invoke('move_pin', { id, x: payload?.x, y: payload?.y }),
    pinRendererReady: () => waitForListens().then(() => invoke('pin_renderer_ready')),
    pinImageReady: (id) => invoke('pin_image_ready', { id }),
    closeScreenshotEditor: () => invoke('close_screenshot_editor'),
    closeScreenshotHistory: () => invoke('close_screenshot_history'),
    hideWindow: () => invoke('hide_window'),
    quitApp: () => invoke('quit_app'),
    screenshotRendererReady: () => waitForListens().then(() => invoke('screenshot_renderer_ready')),
    screenshotReady: () => invoke('screenshot_ready'),
    onStateChanged: (callback) => onEvent('clipboard:state-changed', callback),
    onFocusSearch: () => () => {},
    onOpenLauncher: (callback) => onEvent('window:open-launcher', callback),
    onLauncherShortcutReleased: (callback) => onEvent('window:shortcut-released', callback),
    onCaptureShow: (callback) => onEvent('capture:show', callback),
    onScreenshotBegin: (callback) => onEvent('screenshot:begin', (payload) => callback(decodeB64Fields(payload))),
    onScreenshotHistoryRefresh: (callback) => onEvent('screenshot:history-refresh', callback),
    onScreenshotPinRequest: (callback) => onEvent('screenshot:pin-request', callback),
    onPinShow: (callback) => onEvent('pin:show', (payload) => callback(decodeB64Fields(payload))),
    onPinMenuCommand: (callback) => onEvent('pin:menu-command', callback),
    onPinOperationResult: (callback) => onEvent('pin:operation-result', callback),
  };

  // Renderer key-up fallback feeding the hold state machine (the port of
  // main.cjs before-input-event).
  window.addEventListener('keyup', (event) => {
    if (event.keyCode) {
      invoke('shortcut_key_up', { keyCode: event.keyCode }).catch(() => {});
    }
  });
})();
