const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyText,
  capturePinBounds,
  defaultCaptureRegion,
  detectSensitive,
  entryTitle,
  mergePreferences,
  migrateEntry,
  isRemoteSource,
  isScreenshotEntry,
  removePinnedScreenshot,
  resetPinBounds,
  resolvePasteDelay,
  textFingerprint,
  zoomPinBounds,
} = require('../electron/clipboard-core.cjs');

test('classifies URLs, commands, paths, and plain text', () => {
  assert.equal(classifyText('https://openai.com/docs'), 'url');
  assert.equal(classifyText('git pull --ff-only'), 'code');
  assert.equal(classifyText('E:\\work\\notes.txt'), 'file');
  assert.equal(classifyText('明天上午十点开会'), 'text');
});

test('detects high-confidence secrets without flagging ordinary text', () => {
  assert.equal(detectSensitive('password = super-secret-123').kind, 'password');
  assert.equal(detectSensitive('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').kind, 'bearer');
  assert.equal(detectSensitive('4111 1111 1111 1111').kind, 'payment-card');
  assert.equal(detectSensitive('项目编号 20260812'), null);
});

test('fingerprints normalize Windows newlines', () => {
  assert.equal(textFingerprint('hello\r\nworld'), textFingerprint('hello\nworld'));
});

test('builds useful file titles and migrates old records', () => {
  assert.equal(entryTitle('', 'file', ['E:\\a.txt', 'E:\\b.png']), 'a.txt 等 2 个文件');
  const migrated = migrateEntry({ type: 'text', createdAt: 100 });
  assert.equal(migrated.lastCopiedAt, 100);
  assert.equal(migrated.copyCount, 1);
});

test('preference limits are clamped', () => {
  assert.equal(mergePreferences({ historyLimit: 2 }).historyLimit, 20);
  assert.equal(mergePreferences({ historyLimit: 5000 }).historyLimit, 1000);
  assert.equal(mergePreferences({ pasteDelay: 999 }).pasteDelay, 300);
  assert.equal(mergePreferences({ remotePasteDelay: 1 }).remotePasteDelay, 100);
});

test('uses a longer delay only for recognized remote-control windows', () => {
  assert.equal(isRemoteSource({ app: 'GameViewer', title: 'DESKTOP-01' }), true);
  assert.equal(isRemoteSource({ app: 'mstsc', title: 'Remote Desktop' }), true);
  assert.equal(isRemoteSource({ app: 'chrome', title: 'ChatGPT' }), false);
  const preferences = { pasteDelay: 35, remotePasteDelay: 320, autoRemoteDelay: true };
  assert.equal(resolvePasteDelay(preferences, { app: 'chrome' }), 35);
  assert.equal(resolvePasteDelay(preferences, { app: 'ToDesk' }), 320);
});

test('keeps screenshot history separate from ordinary copied images', () => {
  assert.equal(isScreenshotEntry({ type: 'image', origin: 'screenshot' }), true);
  assert.equal(isScreenshotEntry({ type: 'image' }), false);
  assert.equal(isScreenshotEntry({ type: 'text', origin: 'screenshot' }), false);
});

test('removes only the requested desktop pin record', () => {
  const pins = [{ id: 'shot-a', x: 10 }, { id: 'shot-b', x: 20 }];
  assert.deepEqual(removePinnedScreenshot(pins, 'shot-a'), [{ id: 'shot-b', x: 20 }]);
  assert.deepEqual(removePinnedScreenshot(undefined, 'shot-a'), []);
});

test('centers the default screenshot region on the cursor and clamps it to the display', () => {
  assert.deepEqual(
    defaultCaptureRegion({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 960, y: 540 }),
    { x: 700, y: 380, width: 520, height: 320 },
  );
  assert.deepEqual(
    defaultCaptureRegion({ x: -1280, y: 0, width: 1280, height: 720 }, { x: -1270, y: 10 }),
    { x: -1280, y: 0, width: 520, height: 320 },
  );
});

test('maps physical screenshot pixels back to exact desktop pin bounds', () => {
  assert.deepEqual(
    capturePinBounds(
      { x: -1280, y: 0, width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { x: 150, y: 75, width: 900, height: 450 },
    ),
    { x: -1180, y: 50, width: 600, height: 300 },
  );
});

test('zooms a desktop pin around the mouse pointer and preserves its aspect ratio', () => {
  assert.deepEqual(
    zoomPinBounds({ x: 100, y: 200, width: 400, height: 200 }, { x: 100, y: 50 }, -100, 2),
    { x: 88, y: 194, width: 448, height: 224 },
  );
  assert.deepEqual(
    zoomPinBounds({ x: 100, y: 200, width: 400, height: 200 }, { x: 100, y: 50 }, 100, 2),
    { x: 111, y: 205, width: 357, height: 179 },
  );
});

test('clamps desktop pin wheel zoom to practical minimum and maximum dimensions', () => {
  const minimum = zoomPinBounds({ x: 0, y: 0, width: 80, height: 60 }, { x: 40, y: 30 }, 400, 4 / 3);
  assert.deepEqual({ width: minimum.width, height: minimum.height }, { width: 80, height: 60 });
  const maximum = zoomPinBounds({ x: 0, y: 0, width: 4096, height: 2048 }, { x: 0, y: 0 }, -400, 2);
  assert.deepEqual({ width: maximum.width, height: maximum.height }, { width: 4096, height: 2048 });
});

test('resets a transformed pin around its center using the original display area', () => {
  assert.deepEqual(resetPinBounds({ x: 100, y: 200, width: 800, height: 450 }, 180000, 9 / 16), {
    x: 341, y: 143, width: 318, height: 565,
  });
});
