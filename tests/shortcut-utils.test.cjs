const test = require('node:test');
const assert = require('node:assert/strict');

async function shortcutUtils() {
  return import('../src/shortcut-utils.js');
}

function keyEvent(key, modifiers = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers };
}

test('records local single-key accelerators while global recorders still require modifiers', async () => {
  const { acceleratorFromEvent } = await shortcutUtils();
  assert.equal(acceleratorFromEvent(keyEvent('Enter')), null);
  assert.equal(acceleratorFromEvent(keyEvent('Enter'), { allowSingleKey: true }), 'Enter');
  assert.equal(acceleratorFromEvent(keyEvent('p'), { allowSingleKey: true }), 'P');
  assert.equal(acceleratorFromEvent(keyEvent(' ', { ctrlKey: true })), 'Ctrl+Space');
});

test('matches local screenshot-history accelerators exactly', async () => {
  const { eventMatchesAccelerator } = await shortcutUtils();
  assert.equal(eventMatchesAccelerator(keyEvent('Enter'), 'Enter'), true);
  assert.equal(eventMatchesAccelerator(keyEvent(' '), 'Space'), true);
  assert.equal(eventMatchesAccelerator(keyEvent('Enter', { ctrlKey: true }), 'Ctrl+Enter'), true);
  assert.equal(eventMatchesAccelerator(keyEvent('p'), 'P'), true);
  assert.equal(eventMatchesAccelerator(keyEvent('Enter'), 'Ctrl+Enter'), false);
  assert.equal(eventMatchesAccelerator(keyEvent('p', { shiftKey: true }), 'P'), false);
});
