const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipboardAPI', {
  getState: () => ipcRenderer.invoke('clipboard:get-state'),
  pasteEntry: (id) => ipcRenderer.invoke('clipboard:paste-entry', id),
  togglePin: (id) => ipcRenderer.invoke('clipboard:toggle-pin', id),
  deleteEntry: (id) => ipcRenderer.invoke('clipboard:delete-entry', id),
  createEntry: (payload) => ipcRenderer.invoke('clipboard:create-entry', payload),
  updateShortcut: (accelerator) => ipcRenderer.invoke('clipboard:update-shortcut', accelerator),
  updatePreferences: (preferences) => ipcRenderer.invoke('clipboard:update-preferences', preferences),
  updateScreenshotShortcuts: (shortcuts) => ipcRenderer.invoke('screenshot:update-shortcuts', shortcuts),
  setShortcutRecording: (active) => ipcRenderer.invoke('shortcuts:set-recording', active),
  updateAllShortcuts: (shortcut, screenshotShortcuts) => ipcRenderer.invoke('shortcuts:update-all', { shortcut, screenshotShortcuts }),
  saveScreenshot: (dataUrl, options) => ipcRenderer.invoke('screenshot:save', { dataUrl, ...options }),
  reselectScreenshot: () => ipcRenderer.invoke('screenshot:reselect'),
  getScreenshotHistory: () => ipcRenderer.invoke('screenshot:get-history'),
  getScreenshotEntry: (id) => ipcRenderer.invoke('screenshot:get-entry', id),
  pinScreenshot: (id) => ipcRenderer.invoke('screenshot:pin', id),
  unpinScreenshot: (id) => ipcRenderer.invoke('screenshot:unpin', id),
  closeCurrentPin: () => ipcRenderer.send('pin:close-current'),
  showPinContextMenu: (id, options) => ipcRenderer.send('screenshot:show-pin-menu', { id, ...options }),
  updatePinImage: (id, dataUrl) => ipcRenderer.invoke('screenshot:update-pin-image', { id, dataUrl }),
  recognizePinText: (id) => ipcRenderer.invoke('screenshot:recognize-pin-text', id),
  copyPinText: (id, text) => ipcRenderer.invoke('screenshot:copy-pin-text', { id, text }),
  zoomPin: (id, payload) => ipcRenderer.invoke('screenshot:zoom-pin', { id, ...payload }),
  movePin: (id, payload) => ipcRenderer.send('screenshot:move-pin', { id, ...payload }),
  pinRendererReady: () => ipcRenderer.send('pin:renderer-ready'),
  pinImageReady: (id) => ipcRenderer.send('pin:image-ready', id),
  closeScreenshotEditor: () => ipcRenderer.send('screenshot:editor-close'),
  closeScreenshotHistory: () => ipcRenderer.send('screenshot:history-close'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  quitApp: () => ipcRenderer.send('app:quit'),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('clipboard:state-changed', listener);
    return () => ipcRenderer.removeListener('clipboard:state-changed', listener);
  },
  onFocusSearch: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('window:focus-search', listener);
    return () => ipcRenderer.removeListener('window:focus-search', listener);
  },
  onCaptureShow: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('capture:show', listener);
    return () => ipcRenderer.removeListener('capture:show', listener);
  },
  onScreenshotBegin: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('screenshot:begin', listener);
    return () => ipcRenderer.removeListener('screenshot:begin', listener);
  },
  screenshotRendererReady: () => ipcRenderer.send('screenshot:renderer-ready'),
  screenshotReady: () => ipcRenderer.send('screenshot:ready'),
  onScreenshotHistoryRefresh: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('screenshot:history-refresh', listener);
    return () => ipcRenderer.removeListener('screenshot:history-refresh', listener);
  },
  onScreenshotPinRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('screenshot:pin-request', listener);
    return () => ipcRenderer.removeListener('screenshot:pin-request', listener);
  },
  onPinShow: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('pin:show', listener);
    return () => ipcRenderer.removeListener('pin:show', listener);
  },
  onPinMenuCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('pin:menu-command', listener);
    return () => ipcRenderer.removeListener('pin:menu-command', listener);
  },
  onPinOperationResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('pin:operation-result', listener);
    return () => ipcRenderer.removeListener('pin:operation-result', listener);
  },
});
