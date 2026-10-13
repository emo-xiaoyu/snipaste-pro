const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenWinOcrLines } = require('../electron/win-ocr-core.cjs');

test('splits WinRT word boxes into per-character items with selection prefixes', () => {
  const items = flattenWinOcrLines([
    {
      lineIndex: 0,
      text: '滑 动',
      words: [
        { text: '滑', x: 10, y: 20, w: 30, h: 30 },
        { text: '动', x: 44, y: 20, w: 30, h: 30 },
      ],
    },
    {
      lineIndex: 1,
      text: 'Quality 123',
      words: [
        { text: 'Quality', x: 10, y: 60, w: 70, h: 28 },
        { text: '123', x: 90, y: 60, w: 30, h: 28 },
      ],
    },
  ]);
  assert.deepEqual(items.map((item) => item.text), ['滑', '动', 'Q', 'u', 'a', 'l', 'i', 't', 'y', '1', '2', '3']);
  // prefixes mirror the old engine contract: first item '', new line '\n',
  // new word ' ' — the copy path strips invented gaps between CJK chars.
  assert.deepEqual(items.map((item) => item.prefix), [
    '', ' ', '\n', '', '', '', '', '', '', ' ', '', '',
  ]);
  assert.deepEqual(items.map((item) => item.lineId), [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual(items.map((item) => item.wordId), [0, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3]);
  // Latin characters evenly subdivide their word box
  assert.equal(items[2].bbox.x0, 10);
  assert.equal(Math.round(items[3].bbox.x0 - items[2].bbox.x0), 10);
  assert.equal(items[2].bbox.y0, 60);
  assert.equal(items[2].bbox.y1, 88);
});

test('maps OCR bitmap coordinates back to the source image scale', () => {
  const items = flattenWinOcrLines([
    { text: '甲', x: 0, y: 0, w: 100, h: 50, words: [{ text: '甲', x: 0, y: 0, w: 100, h: 50 }] },
  ], { scaleX: 0.5, scaleY: 4 });
  assert.deepEqual(items[0].bbox, { x0: 0, y0: 0, x1: 50, y1: 200 });
});

test('drops empty and degenerate words and tolerates missing lines', () => {
  assert.deepEqual(flattenWinOcrLines(null), []);
  const items = flattenWinOcrLines([
    { text: ' ', words: [{ text: '  ', x: 1, y: 1, w: 5, h: 5 }, { text: '宽', x: 1, y: 1, w: 0, h: 5 }] },
    { text: '', words: [] },
  ]);
  assert.equal(items.length, 0);
});
