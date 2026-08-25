const transformMatrices = {
  'rotate-right': (width, height) => ({ width: height, height: width, matrix: [0, 1, -1, 0, height, 0] }),
  'rotate-left': (width, height) => ({ width: height, height: width, matrix: [0, -1, 1, 0, 0, width] }),
  'flip-horizontal': (width, height) => ({ width, height, matrix: [-1, 0, 0, 1, width, 0] }),
  'flip-vertical': (width, height) => ({ width, height, matrix: [1, 0, 0, -1, 0, height] }),
};

export function pinImageTransformPlan(operation, width, height) {
  const createPlan = transformMatrices[operation];
  const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
  if (!createPlan) throw new Error(`Unsupported pin image transform: ${operation}`);
  return createPlan(sourceWidth, sourceHeight);
}
