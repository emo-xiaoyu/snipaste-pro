const test = require('node:test');
const assert = require('node:assert/strict');

test('builds exact canvas transforms for pin rotation and mirroring', async () => {
  const { pinImageTransformPlan } = await import('../src/pin-image-transform.js');
  assert.deepEqual(pinImageTransformPlan('rotate-right', 640, 360), {
    width: 360, height: 640, matrix: [0, 1, -1, 0, 360, 0],
  });
  assert.deepEqual(pinImageTransformPlan('rotate-left', 640, 360), {
    width: 360, height: 640, matrix: [0, -1, 1, 0, 0, 640],
  });
  assert.deepEqual(pinImageTransformPlan('flip-horizontal', 640, 360), {
    width: 640, height: 360, matrix: [-1, 0, 0, 1, 640, 0],
  });
  assert.deepEqual(pinImageTransformPlan('flip-vertical', 640, 360), {
    width: 640, height: 360, matrix: [1, 0, 0, -1, 0, 360],
  });
});

test('rejects unsupported pin transforms', async () => {
  const { pinImageTransformPlan } = await import('../src/pin-image-transform.js');
  assert.throws(() => pinImageTransformPlan('skew', 100, 100), /Unsupported/);
});
