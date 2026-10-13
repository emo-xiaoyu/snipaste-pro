// Applies an incremental clipboard state message (full: false) to the
// current entry list. Pure so it can be unit-tested without Electron.
export function applyClipboardDelta(entries, delta) {
  if (!delta) return entries;
  let next = entries;
  if (Array.isArray(delta.removedIds) && delta.removedIds.length) {
    const removed = new Set(delta.removedIds);
    next = next.filter((entry) => !removed.has(entry.id));
  }
  if (delta.updatedEntry) {
    next = next.map((entry) => (entry.id === delta.updatedEntry.id
      ? { ...entry, ...delta.updatedEntry }
      : entry));
  }
  if (delta.capturedEntry) {
    // A capture may be a brand-new entry or a duplicate moved back to the top.
    next = next.filter((entry) => entry.id !== delta.capturedEntry.id);
    const index = Number.isInteger(delta.capturedIndex)
      ? Math.max(0, Math.min(delta.capturedIndex, next.length))
      : 0;
    next = [...next.slice(0, index), delta.capturedEntry, ...next.slice(index)];
  }
  return next;
}
