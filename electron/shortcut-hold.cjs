// Virtual-key groups: left/right modifiers both satisfy the configured chord.
function shortcutKeyGroups(accelerator) {
  const named = { alt: [18], option: [18], control: [17], ctrl: [17], commandorcontrol: [17], cmdorctrl: [17],
    shift: [16], super: [91, 92], meta: [91, 92], command: [91, 92], cmd: [91, 92],
    space: [32], tab: [9], enter: [13], return: [13], escape: [27], esc: [27], backspace: [8],
    delete: [46], insert: [45], home: [36], end: [35], pageup: [33], pagedown: [34],
    up: [38], down: [40], left: [37], right: [39], plus: [187], minus: [189],
    '=': [187], '-': [189], ',': [188], '.': [190], '/': [191], ';': [186], "'": [222],
    '[': [219], ']': [221], '\\': [220], '`': [192] };
  const groups = String(accelerator || '').split('+').map((part) => {
    const key = part.trim().toLowerCase();
    if (named[key]) return named[key];
    if (/^[a-z0-9]$/.test(key)) return [key.toUpperCase().charCodeAt(0)];
    if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return [111 + Number(key.slice(1))];
    if (/^num[0-9]$/.test(key)) return [96 + Number(key.slice(3))];
    return null;
  });
  return groups.length && groups.every(Boolean) ? groups : null;
}

function createShortcutHold({ keysDown, onRelease, schedule = setTimeout, cancel = clearTimeout, intervalMs = 16 }) {
  let active = null;
  let timer = null;
  let nextId = 0;
  function stop() {
    active = null;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function release() {
    if (!active) return;
    const committed = active.committed;
    stop();
    if (!committed) onRelease();
  }
  async function check(session = active) {
    if (!session) return false;
    if (session !== active) return false;
    let down = false;
    try { down = await keysDown(session.groups); } catch { /* Fail closed if the native bridge stops. */ }
    if (session !== active) return false;
    if (!down) release();
    return Boolean(down);
  }
  async function poll(session) {
    if (!await check(session) || session !== active) return false;
    timer = schedule(() => { timer = null; void poll(session); }, intervalMs);
    return true;
  }
  return {
    start(accelerator) {
      if (active) return null; // OS repeat never toggles or repositions the wheel.
      const groups = shortcutKeyGroups(accelerator);
      if (!groups) return null;
      const session = { id: ++nextId, groups };
      active = session;
      session.ready = poll(session);
      return session;
    },
    isActive: (session) => session ? session === active : Boolean(active),
    isPending: () => Boolean(active && !active.committed),
    sessionId: () => active?.id ?? null,
    commit() { if (active) active.committed = true; },
    check, stop, release,
    keyUp(keyCode) { if (active?.groups.some((group) => group.includes(keyCode))) release(); },
  };
}

module.exports = { shortcutKeyGroups, createShortcutHold };
