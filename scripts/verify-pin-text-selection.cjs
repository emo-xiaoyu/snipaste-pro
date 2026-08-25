const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fixtureText = 'Test 123';
const fixtureItems = [...fixtureText.replace(' ', '')].map((text, index) => ({
  text,
  prefix: index === 4 ? ' ' : '',
  lineId: 0,
  wordId: index < 4 ? 0 : 1,
  bbox: { x0: 60 + index * 24, y0: 52, x1: 82 + index * 24, y1: 84 },
}));
const fixtureImageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="520" height="200">
    <rect width="520" height="200" fill="#fff"/>
    <text x="60" y="82" font-family="Arial" font-size="36" fill="#111">${fixtureText}</text>
  </svg>
`)}`;

let copiedText = '';
let moveCalls = 0;

ipcMain.handle('screenshot:get-entry', () => ({ id: 'qa-pin', imageUrl: fixtureImageUrl }));
ipcMain.handle('screenshot:recognize-pin-text', async () => {
  await wait(480);
  return {
    success: true,
    charCount: fixtureText.length,
    confidence: 99,
    imageSize: { width: 520, height: 200 },
    items: fixtureItems,
  };
});
ipcMain.handle('screenshot:copy-pin-text', (_event, payload) => {
  copiedText = String(payload?.text || '');
  return { success: true, charCount: copiedText.length };
});
ipcMain.handle('screenshot:zoom-pin', () => ({ success: true }));
ipcMain.handle('screenshot:unpin', () => ({ success: true }));
ipcMain.on('screenshot:move-pin', () => { moveCalls += 1; });
ipcMain.on('pin:renderer-ready', () => {});
ipcMain.on('pin:image-ready', () => {});

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 520,
    height: 200,
    show: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false,
    },
  });
  await window.loadFile(path.join(__dirname, '..', 'dist', 'client', 'pin.html'), { query: { id: 'qa-pin' } });
  await wait(120);

  window.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 120, button: 'left', clickCount: 1 });
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 50, y: 120, button: 'left' });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: 50, y: 120, button: 'left', clickCount: 1 });
  await wait(80);
  const afterShortDrag = await window.webContents.executeJavaScript(`({
    textMode: document.querySelector('.pin-card')?.classList.contains('pin-card--text-mode'),
  })`);

  window.webContents.sendInputEvent({ type: 'mouseDown', x: 66, y: 70, button: 'left', clickCount: 1 });
  await wait(200);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 145, y: 70, button: 'left' });
  window.webContents.sendInputEvent({ type: 'mouseUp', x: 145, y: 70, button: 'left', clickCount: 1 });
  await wait(260);
  const afterLongPress = await window.webContents.executeJavaScript(`({
    textMode: document.querySelector('.pin-card')?.classList.contains('pin-card--text-mode'),
    selectedCount: document.querySelectorAll('.pin-text-layer .is-selected').length,
    overlayContainsNoOcrText: document.querySelector('.pin-text-layer')?.textContent === '',
    hasCopyAction: Boolean(document.querySelector('.pin-text-actions button')),
  })`);
  if (process.env.PASTY_QA_SCREENSHOT) {
    fs.writeFileSync(process.env.PASTY_QA_SCREENSHOT, (await window.capturePage()).toPNG());
  }

  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
  await wait(80);

  const result = {
    shortDragMovedPin: moveCalls > 0,
    shortDragStayedOutOfTextMode: afterShortDrag.textMode === false,
    longPressEnteredTextMode: afterLongPress.textMode === true,
    selectedCharacterCount: afterLongPress.selectedCount,
    selectionDoesNotRedrawOcrText: afterLongPress.overlayContainsNoOcrText,
    copyActionVisible: afterLongPress.hasCopyAction,
    copiedOnlySelection: copiedText.length > 0 && copiedText.length < fixtureText.length,
    copiedCharacterCount: copiedText.length,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const passed = Object.values(result).every((value) => typeof value === 'number' || value === true);
  window.destroy();
  app.exit(passed ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
  app.quit();
});
