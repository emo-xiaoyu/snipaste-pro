const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaddleOcrService, flattenPaddleLines } = require('../electron/paddle-ocr-core.cjs');

const line = (text, mean, top, left = 10, width = 300) => ({
  text,
  mean,
  box: [[left, top], [left + width, top], [left + width, top + 20], [left, top + 20]],
});

test('keeps strong Chinese lines and filters isolated low-confidence OCR garbage', () => {
  const result = flattenPaddleLines([
    line('s HZ-. GBexFET.', 0.7, 10),
    line('用户轻按滑动时直接读取缓存，不会重复识别。', 0.99, 40),
    line('质量更好的结果', 0.97, 70),
  ]);
  assert.equal(result.text, '用户轻按滑动时直接读取缓存，不会重复识别。\n质量更好的结果');
  assert.equal(result.items.some((item) => item.text === '滢' || item.text === '里'), false);
  assert.equal(result.items[0].text, '用');
  assert.equal(result.items.at(-1).text, '果');
  assert.ok(result.confidence > 97);
});

test('creates ordered character hit boxes while preserving real spaces and line breaks', () => {
  const result = flattenPaddleLines([
    line('OCR 缓存 64 张', 0.98, 12, 20, 240),
    line('Ctrl+C 复制', 0.96, 44, 20, 180),
  ]);
  const copied = result.items.map((item, index) => `${index === 0 ? '' : item.prefix}${item.text}`).join('');
  assert.equal(copied, 'OCR 缓存 64 张\nCtrl+C 复制');
  assert.ok(result.items.every((item, index, items) => index === 0 || item.lineId !== items[index - 1].lineId || item.bbox.x0 >= items[index - 1].bbox.x1));
});

test('serializes Paddle OCR jobs and initializes the model once', async () => {
  let factories = 0;
  let active = 0;
  let maximumActive = 0;
  const service = createPaddleOcrService({ factory: async () => {
    factories += 1;
    return {
      detect: async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return [line(`结果${value}`, 0.99, 10)];
      },
    };
  } });
  const results = await Promise.all([service.recognize('A'), service.recognize('B')]);
  assert.equal(factories, 1);
  assert.equal(maximumActive, 1);
  assert.deepEqual(results.map((result) => result.text), ['结果A', '结果B']);
});
