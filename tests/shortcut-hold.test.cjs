const test = require('node:test');
const assert = require('node:assert/strict');
const { shortcutKeyGroups, createShortcutHold } = require('../electron/shortcut-hold.cjs');

test('configured accelerator maps to physical Windows chord keys', () => {
  assert.deepEqual(shortcutKeyGroups('Alt+V'), [[18], [86]]);
  assert.deepEqual(shortcutKeyGroups('Ctrl+Shift+Space'), [[17], [16], [32]]);
  assert.deepEqual(shortcutKeyGroups('Super+F12'), [[91, 92], [123]]);
  assert.equal(shortcutKeyGroups('Alt+UnknownKey'), null);
});

test('native polling closes a hold once, even without a renderer key-up event', async () => {
  let down = true;
  let released = 0;
  const timers = new Map();
  let id = 0;
  const hold = createShortcutHold({ keysDown: async () => down, onRelease: () => { released++; },
    schedule: (fn) => { timers.set(++id, fn); return id; }, cancel: (key) => timers.delete(key) });
  const session = hold.start('Alt+V');
  assert.equal(await session.ready, true);
  assert.equal(hold.start('Alt+V'), null);
  down = false;
  const poll = [...timers.values()][0];
  await poll();
  await new Promise(setImmediate);
  assert.equal(released, 1);
  assert.equal(hold.isActive(), false);
  hold.keyUp(18);
  assert.equal(released, 1);
});

test('stopped and superseded native checks cannot close a newer invocation', async () => {
  const complete = [];
  let released = 0;
  const hold = createShortcutHold({ keysDown: () => new Promise((resolve) => complete.push(resolve)),
    onRelease: () => { released++; }, schedule: () => 0, cancel() {} });
  const old = hold.start('Alt+V');
  hold.stop();
  const current = hold.start('Alt+V');
  complete[0](false);
  complete[1](true);
  assert.equal(await old.ready, false);
  assert.equal(await current.ready, true);
  assert.equal(released, 0);
  assert.equal(hold.isActive(current), true);
});

test('bridge failure cancels a hold instead of leaving an interactive wheel open', async () => {
  let released = 0;
  const hold = createShortcutHold({ keysDown: async () => { throw new Error('bridge stopped'); }, onRelease: () => { released++; } });
  assert.equal(await hold.start('Alt+V').ready, false);
  assert.equal(released, 1);
});
