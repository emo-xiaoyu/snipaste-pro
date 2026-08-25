const test = require('node:test');
const assert = require('node:assert/strict');

test('keeps the automatic screenshot selection centered under the pointer', async () => {
  const { centerSelectionOnPointer } = await import('../src/screenshot-selection.js');
  assert.deepEqual(
    centerSelectionOnPointer(
      { x: 0, y: 0, width: 520, height: 320 },
      { x: 960, y: 540 },
      { width: 1920, height: 1080 },
    ),
    { x: 700, y: 380, width: 520, height: 320 },
  );
});

test('clamps a pointer-following selection to every image edge', async () => {
  const { centerSelectionOnPointer } = await import('../src/screenshot-selection.js');
  const selection = { x: 700, y: 380, width: 520, height: 320 };
  const imageSize = { width: 1920, height: 1080 };
  assert.deepEqual(
    centerSelectionOnPointer(selection, { x: 10, y: 12 }, imageSize),
    { x: 0, y: 0, width: 520, height: 320 },
  );
  assert.deepEqual(
    centerSelectionOnPointer(selection, { x: 1910, y: 1070 }, imageSize),
    { x: 1400, y: 760, width: 520, height: 320 },
  );
});
