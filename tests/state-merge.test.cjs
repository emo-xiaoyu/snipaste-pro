const test = require('node:test');
const assert = require('node:assert/strict');

test('applyClipboardDelta applies capture, update, and removal in one message', async () => {
  const { applyClipboardDelta } = await import('../src/state-merge.js');
  const entries = [
    { id: 'a', content: 'first' },
    { id: 'b', content: 'second' },
    { id: 'c', content: 'third' },
  ];
  const result = applyClipboardDelta(entries, {
    capturedEntry: { id: 'd', content: 'new' },
    updatedEntry: { id: 'b', pinned: true },
    removedIds: ['c'],
  });
  assert.deepEqual(result.map((entry) => entry.id), ['d', 'a', 'b']);
  assert.equal(result[2].pinned, true);
  assert.equal(result[2].content, 'second');
});

test('applyClipboardDelta moves an existing duplicate capture back to the top', async () => {
  const { applyClipboardDelta } = await import('../src/state-merge.js');
  const entries = [
    { id: 'a', copyCount: 1 },
    { id: 'b' },
    { id: 'c' },
  ];
  const result = applyClipboardDelta(entries, { capturedEntry: { id: 'c', copyCount: 2 } });
  assert.deepEqual(result.map((entry) => entry.id), ['c', 'a', 'b']);
  assert.equal(result[0].copyCount, 2);
});

test('applyClipboardDelta returns the same array when nothing changes', async () => {
  const { applyClipboardDelta } = await import('../src/state-merge.js');
  const entries = [{ id: 'a' }];
  assert.equal(applyClipboardDelta(entries, { notice: 'hi' }), entries);
  assert.equal(applyClipboardDelta(entries, null), entries);
});

test('a delayed image keeps its capture position behind newer entries', async () => {
  const { applyClipboardDelta } = await import('../src/state-merge.js');
  const entries = [{ id: 'newer-text' }, { id: 'old-text' }];
  const result = applyClipboardDelta(entries, { capturedEntry: { id: 'image' }, capturedIndex: 1 });
  assert.deepEqual(result.map((entry) => entry.id), ['newer-text', 'image', 'old-text']);
});
