const test = require('node:test');
const assert = require('node:assert/strict');

const items = [
  { text: '订', prefix: '', wordId: 0, bbox: { x0: 10, y0: 10, x1: 30, y1: 30 } },
  { text: '单', prefix: '', wordId: 0, bbox: { x0: 30, y0: 10, x1: 50, y1: 30 } },
  { text: '1', prefix: ' ', wordId: 1, bbox: { x0: 60, y0: 10, x1: 70, y1: 30 } },
  { text: '2', prefix: '', wordId: 1, bbox: { x0: 70, y0: 10, x1: 80, y1: 30 } },
  { text: '8', prefix: '', wordId: 1, bbox: { x0: 80, y0: 10, x1: 90, y1: 30 } },
  { text: '完', prefix: '\n', wordId: 2, bbox: { x0: 10, y0: 40, x1: 30, y1: 60 } },
];

test('builds copied text from an exact forward or reverse character range', async () => {
  const { normalizeSelectionRange, textFromSelection } = await import('../src/pin-text-selection.js');
  const forward = normalizeSelectionRange(1, 5);
  const reverse = normalizeSelectionRange(5, 1);
  assert.deepEqual(forward, { start: 1, end: 5 });
  assert.deepEqual(reverse, forward);
  assert.equal(textFromSelection(items, forward), '单 128\n完');
});

test('removes OCR word gaps between Chinese characters without merging Latin text', async () => {
  const { normalizeCopiedText } = await import('../src/pin-text-selection.js');
  assert.equal(
    normalizeCopiedText('OCR 字 符 不 再 覆 盖 原 截 图 , 只 显 示 半 透 明 蓝 色 选 区'),
    'OCR 字符不再覆盖原截图,只显示半透明蓝色选区',
  );
  assert.equal(normalizeCopiedText('订单 128 GB'), '订单 128 GB');
});

test('selects a whole OCR word and finds the nearest character box', async () => {
  const { nearestTextItemIndex, wordRangeAt } = await import('../src/pin-text-selection.js');
  assert.deepEqual(wordRangeAt(items, 3), { start: 2, end: 4 });
  assert.equal(nearestTextItemIndex(items, { x: 76, y: 18 }), 3);
  assert.equal(nearestTextItemIndex(items, { x: 12, y: 49 }), 5);
});

test('hits only real OCR text boxes so blank pin areas remain draggable', async () => {
  const { textItemIndexAtPoint } = await import('../src/pin-text-selection.js');
  assert.equal(textItemIndexAtPoint(items, { x: 76, y: 18 }), 3);
  assert.equal(textItemIndexAtPoint(items, { x: 53, y: 18 }), 1);
  assert.equal(textItemIndexAtPoint(items, { x: 140, y: 100 }), -1);
});
