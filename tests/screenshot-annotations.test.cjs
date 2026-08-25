const test = require('node:test');
const assert = require('node:assert/strict');

test('creates a dragged text box and keeps it inside the screenshot selection', async () => {
  const { textRectFromDrag } = await import('../src/screenshot-annotations.js');
  const bounds = { x: 100, y: 80, width: 500, height: 300 };
  assert.deepEqual(
    textRectFromDrag({ x: 140, y: 120 }, { x: 390, y: 230 }, bounds),
    { x: 140, y: 120, width: 250, height: 110 },
  );
  assert.deepEqual(
    textRectFromDrag({ x: 580, y: 360 }, { x: 582, y: 361 }, bounds),
    { x: 360, y: 292, width: 240, height: 88 },
  );
});

test('wraps Chinese, Latin text, and explicit line breaks inside a text annotation', async () => {
  const { wrapTextLines } = await import('../src/screenshot-annotations.js');
  const measure = (value) => [...value].length * 10;
  assert.deepEqual(wrapTextLines('中文测试 ABCD\n第二行', 40, measure), ['中文测试', 'ABCD', '第二行']);
});

test('maps the existing line-width choices to readable text sizes', async () => {
  const { textFontSizeFromLineWidth } = await import('../src/screenshot-annotations.js');
  assert.deepEqual([3, 6, 10].map(textFontSizeFromLineWidth), [18, 24, 36]);
});
