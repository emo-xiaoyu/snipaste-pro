export function normalizeSelectionRange(anchorIndex, focusIndex) {
  if (!Number.isInteger(anchorIndex) || !Number.isInteger(focusIndex)) return null;
  return { start: Math.min(anchorIndex, focusIndex), end: Math.max(anchorIndex, focusIndex) };
}

export function normalizeCopiedText(value) {
  return String(value || '')
    .replace(/([\u3400-\u9fff])[\t ]+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/[\t ]+([，。！？；：、,.!?;:])/g, '$1')
    .replace(/([，。！？；：、,.!?;:])[\t ]+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/[\t ]+\n/g, '\n')
    .trim();
}

export function textFromSelection(items, range) {
  if (!range || !Array.isArray(items) || !items.length) return '';
  return normalizeCopiedText(items.slice(range.start, range.end + 1)
    .map((item, index) => `${index === 0 ? '' : item.prefix || ''}${item.text || ''}`)
    .join(''));
}

export function wordRangeAt(items, index) {
  const target = items?.[index];
  if (!target) return null;
  let start = index;
  let end = index;
  while (start > 0 && items[start - 1]?.wordId === target.wordId) start -= 1;
  while (end < items.length - 1 && items[end + 1]?.wordId === target.wordId) end += 1;
  return { start, end };
}

export function nearestTextItemIndex(items, point) {
  if (!Array.isArray(items) || !items.length || !point) return -1;
  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    const box = item.bbox;
    if (!box) return;
    const dx = point.x < box.x0 ? box.x0 - point.x : point.x > box.x1 ? point.x - box.x1 : 0;
    const dy = point.y < box.y0 ? box.y0 - point.y : point.y > box.y1 ? point.y - box.y1 : 0;
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

export function textItemIndexAtPoint(items, point, padding = 3) {
  if (!Array.isArray(items) || !items.length || !point) return -1;
  const tolerance = Math.max(0, Number(padding) || 0);
  let hitIndex = -1;
  let hitDistance = Number.POSITIVE_INFINITY;
  items.forEach((item, index) => {
    const box = item.bbox;
    if (!box) return;
    const dx = point.x < box.x0 ? box.x0 - point.x : point.x > box.x1 ? point.x - box.x1 : 0;
    const dy = point.y < box.y0 ? box.y0 - point.y : point.y > box.y1 ? point.y - box.y1 : 0;
    if (dx > tolerance || dy > tolerance) return;
    const distance = dx * dx + dy * dy;
    if (distance < hitDistance) {
      hitDistance = distance;
      hitIndex = index;
    }
  });
  return hitIndex;
}
