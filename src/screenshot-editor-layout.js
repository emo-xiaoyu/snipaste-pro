export function insetViewport(viewport, inset = {}) {
  const left = Math.max(0, Number(inset.left) || 0);
  const top = Math.max(0, Number(inset.top) || 0);
  const right = Math.max(0, Number(inset.right) || 0);
  const bottom = Math.max(0, Number(inset.bottom) || 0);
  return {
    left,
    top,
    width: Math.max(1, (Number(viewport?.width) || 0) - left - right),
    height: Math.max(1, (Number(viewport?.height) || 0) - top - bottom),
  };
}

export function selectionViewportRect(selection, imageSize, viewport, inset = {}) {
  if (!selection || !imageSize || imageSize.width <= 0 || imageSize.height <= 0) return null;
  const canvas = insetViewport(viewport, inset);
  return {
    left: canvas.left + selection.x / imageSize.width * canvas.width,
    top: canvas.top + selection.y / imageSize.height * canvas.height,
    width: selection.width / imageSize.width * canvas.width,
    height: selection.height / imageSize.height * canvas.height,
  };
}

export function floatingToolbarPosition(selectionRect, viewport, toolbarSize, options = {}) {
  if (!selectionRect || !viewport || !toolbarSize) return null;
  const gap = Math.max(0, Number(options.gap) || 10);
  const edgePadding = Math.max(0, Number(options.edgePadding) || 12);
  const viewportWidth = Math.max(0, Number(viewport.width) || 0);
  const viewportHeight = Math.max(0, Number(viewport.height) || 0);
  const toolbarWidth = Math.min(Math.max(1, Number(toolbarSize.width) || 1), Math.max(1, viewportWidth - edgePadding * 2));
  const toolbarHeight = Math.min(Math.max(1, Number(toolbarSize.height) || 1), Math.max(1, viewportHeight - edgePadding * 2));
  const selectionRight = Number(selectionRect.left) + Number(selectionRect.width);
  const selectionBottom = Number(selectionRect.top) + Number(selectionRect.height);
  const fitsBelow = selectionBottom + gap + toolbarHeight <= viewportHeight - edgePadding;
  const desiredTop = fitsBelow
    ? selectionBottom + gap
    : Number(selectionRect.top) - gap - toolbarHeight;
  const maxLeft = Math.max(edgePadding, viewportWidth - edgePadding - toolbarWidth);
  const maxTop = Math.max(edgePadding, viewportHeight - edgePadding - toolbarHeight);
  return {
    left: Math.min(maxLeft, Math.max(edgePadding, selectionRight - toolbarWidth)),
    top: Math.min(maxTop, Math.max(edgePadding, desiredTop)),
    placement: fitsBelow ? 'below' : 'above',
  };
}
