export function centerSelectionOnPointer(selection, pointer, imageSize) {
  if (!selection || !pointer || !imageSize) return selection;
  const width = Math.min(selection.width, imageSize.width);
  const height = Math.min(selection.height, imageSize.height);
  return {
    ...selection,
    x: Math.min(imageSize.width - width, Math.max(0, pointer.x - width / 2)),
    y: Math.min(imageSize.height - height, Math.max(0, pointer.y - height / 2)),
    width,
    height,
  };
}
