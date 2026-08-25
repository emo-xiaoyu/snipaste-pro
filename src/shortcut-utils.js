const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);

const keyNames = {
  ' ': 'Space',
  Spacebar: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
};

function normalizedKey(key) {
  const named = keyNames[key] || key;
  return named.length === 1 ? named.toUpperCase() : named;
}

export function acceleratorFromEvent(event, { allowSingleKey = false } = {}) {
  if (modifierKeys.has(event.key)) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  if (!modifiers.length && !allowSingleKey) return null;
  return [...modifiers, normalizedKey(event.key)].join('+');
}

export function eventMatchesAccelerator(event, accelerator) {
  const parts = String(accelerator || '').split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return false;
  const expectedKey = parts.at(-1).toLocaleLowerCase();
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLocaleLowerCase()));
  const expectsCtrl = modifiers.has('ctrl') || modifiers.has('control') || modifiers.has('commandorcontrol') || modifiers.has('cmdorctrl');
  const expectsMeta = modifiers.has('super') || modifiers.has('meta') || modifiers.has('command') || modifiers.has('cmd');
  if (Boolean(event.ctrlKey) !== expectsCtrl) return false;
  if (Boolean(event.altKey) !== modifiers.has('alt')) return false;
  if (Boolean(event.shiftKey) !== modifiers.has('shift')) return false;
  if (Boolean(event.metaKey) !== expectsMeta) return false;
  return normalizedKey(event.key).toLocaleLowerCase() === expectedKey;
}
