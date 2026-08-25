const test = require('node:test');
const assert = require('node:assert/strict');

test('keeps the secondary-annotation image at its original visible size inside a shadow margin', async () => {
  const { insetViewport, selectionViewportRect } = await import('../src/screenshot-editor-layout.js');
  const viewport = { width: 460, height: 320 };
  const inset = { left: 30, top: 30, right: 30, bottom: 30 };
  assert.deepEqual(insetViewport(viewport, inset), { left: 30, top: 30, width: 400, height: 260 });
  assert.deepEqual(selectionViewportRect(
    { x: 0, y: 0, width: 800, height: 520 },
    { width: 800, height: 520 },
    viewport,
    inset,
  ), { left: 30, top: 30, width: 400, height: 260 });
});

test('places the screenshot toolbar at the selection bottom-right when space is available', async () => {
  const { floatingToolbarPosition } = await import('../src/screenshot-editor-layout.js');
  assert.deepEqual(floatingToolbarPosition(
    { left: 220, top: 120, width: 640, height: 320 },
    { width: 1280, height: 900 },
    { width: 520, height: 48 },
  ), { left: 340, top: 450, placement: 'below' });
});

test('flips the screenshot toolbar to the selection top-right near the screen bottom', async () => {
  const { floatingToolbarPosition } = await import('../src/screenshot-editor-layout.js');
  assert.deepEqual(floatingToolbarPosition(
    { left: 420, top: 610, width: 700, height: 250 },
    { width: 1280, height: 900 },
    { width: 520, height: 48 },
  ), { left: 600, top: 552, placement: 'above' });
});

test('keeps the screenshot toolbar inside the viewport edges', async () => {
  const { floatingToolbarPosition } = await import('../src/screenshot-editor-layout.js');
  assert.deepEqual(floatingToolbarPosition(
    { left: 4, top: 80, width: 180, height: 120 },
    { width: 640, height: 480 },
    { width: 520, height: 48 },
  ), { left: 12, top: 210, placement: 'below' });
});
