const test = require('node:test');
const assert = require('node:assert/strict');
const { createPinOcrCache } = require('../electron/pin-ocr-cache.cjs');

test('shares an in-flight OCR request and reuses its cached result', async () => {
  let calls = 0;
  const cache = createPinOcrCache({
    load: async (value) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `${value}-recognized`;
    },
  });
  const [first, second] = await Promise.all([cache.get('image-1', 'source'), cache.get('image-1', 'ignored')]);
  assert.equal(first, 'source-recognized');
  assert.equal(second, first);
  assert.equal(await cache.get('image-1', 'ignored-again'), first);
  assert.equal(calls, 1);
});

test('evicts the least recently used OCR result and retries failures', async () => {
  let failures = 0;
  const cache = createPinOcrCache({
    limit: 2,
    load: async (value) => {
      if (value === 'fail' && failures++ === 0) throw new Error('temporary OCR failure');
      return value;
    },
  });
  await assert.rejects(cache.get('bad', 'fail'));
  assert.equal(cache.has('bad'), false);
  assert.equal(await cache.get('bad', 'recovered'), 'recovered');
  await cache.get('keep', 'keep');
  await cache.get('bad', 'ignored');
  await cache.get('new', 'new');
  assert.equal(cache.has('bad'), true);
  assert.equal(cache.has('keep'), false);
  assert.equal(cache.size, 2);
});
