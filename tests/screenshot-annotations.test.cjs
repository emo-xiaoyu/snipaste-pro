const test = require('node:test');
const assert = require('node:assert/strict');

test('creates a dragged text box and keeps it inside the screenshot selection', async () => {
  const { textRectFromDrag } = await import('../src/screenshot-annotations.js');
  const bounds = { x: 100, y: 80, width: 500, height: 300 };
  assert.deepEqual(
    textRectFromDrag({ x: 140, y: 120 }, { x: 390, y: 230 }, bounds),
    { x: 140, y: 120, width: 250, height: 110 },
  );
  assert.deepEqual(
    textRectFromDrag({ x: 580, y: 360 }, { x: 582, y: 361 }, bounds),
    { x: 360, y: 292, width: 240, height: 88 },
  );
});

test('wraps Chinese, Latin text, and explicit line breaks inside a text annotation', async () => {
  const { wrapTextLines } = await import('../src/screenshot-annotations.js');
  const measure = (value) => [...value].length * 10;
  assert.deepEqual(wrapTextLines('中文测试 ABCD\n第二行', 40, measure), ['中文测试', 'ABCD', '第二行']);
});

test('maps the existing line-width choices to readable text sizes', async () => {
  const { textFontSizeFromLineWidth } = await import('../src/screenshot-annotations.js');
  assert.deepEqual([3, 6, 10].map(textFontSizeFromLineWidth), [18, 24, 36]);
});

test('maps line-width choices to highlighter widths and renders semi-transparent highlighter stroke', async () => {
  const { highlighterLineWidth, renderStrokes } = await import('../src/screenshot-annotations.js');
  assert.deepEqual([3, 6, 10].map(highlighterLineWidth), [14, 22, 32]);

  const calls = [];
  const mockContext = {
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    save() { calls.push('save'); },
    restore() { calls.push('restore'); },
    beginPath() { calls.push('beginPath'); },
    moveTo(x, y) { calls.push(`moveTo(${x},${y})`); },
    lineTo(x, y) { calls.push(`lineTo(${x},${y})`); },
    stroke() { calls.push('stroke'); },
  };

  const strokes = [
    {
      tool: 'highlighter',
      color: '#ffe066',
      lineWidth: 6,
      points: [{ x: 10, y: 20 }, { x: 50, y: 20 }],
    },
  ];

  renderStrokes(mockContext, strokes);
  assert.equal(mockContext.strokeStyle, '#ffe066');
  assert.equal(mockContext.lineWidth, 22);
  assert.equal(mockContext.globalAlpha, 0.38);
  assert.deepEqual(calls, ['save', 'beginPath', 'moveTo(10,20)', 'lineTo(50,20)', 'stroke', 'restore']);
});

test('converts rgb to hsl and formats color values in hex, rgb, and hsl', async () => {
  const { rgbToHsl, formatColorValue } = await import('../src/screenshot-annotations.js');
  assert.deepEqual(rgbToHsl(255, 0, 0), { h: 0, s: 100, l: 50 });
  assert.deepEqual(rgbToHsl(0, 255, 0), { h: 120, s: 100, l: 50 });
  assert.deepEqual(rgbToHsl(0, 0, 255), { h: 240, s: 100, l: 50 });
  assert.deepEqual(rgbToHsl(0, 0, 0), { h: 0, s: 0, l: 0 });
  assert.deepEqual(rgbToHsl(255, 255, 255), { h: 0, s: 0, l: 100 });

  const pixel = { r: 47, g: 128, b: 237, hex: '#2F80ED' };
  assert.equal(formatColorValue(pixel, 'hex'), '#2F80ED');
  assert.equal(formatColorValue(pixel, 'rgb'), 'rgb(47, 128, 237)');
  assert.equal(formatColorValue(pixel, 'hsl'), 'hsl(214, 84%, 56%)');

  // Fallbacks and defaults
  assert.equal(formatColorValue(pixel), '#2F80ED');
  assert.equal(formatColorValue(null), '');
});

test('maps line-width choices to redaction brush widths, mosaic blocks, and blur radii', async () => {
  const {
    redactBrushWidth,
    mosaicBlockSize,
    blurRadius,
  } = await import('../src/screenshot-annotations.js');
  assert.deepEqual([3, 6, 10].map(redactBrushWidth), [26, 46, 74]);
  assert.deepEqual([3, 6, 10].map(mosaicBlockSize), [8, 14, 22]);
  assert.deepEqual([3, 6, 10].map(blurRadius), [6, 10, 16]);
  // Out-of-range values clamp to the endpoint widths, like the other mappers.
  assert.deepEqual([0, 1, 99].map(redactBrushWidth), [26, 26, 74]);
  assert.deepEqual([0, 1, 99].map(mosaicBlockSize), [8, 8, 22]);
  assert.deepEqual([0, 1, 99].map(blurRadius), [6, 6, 16]);
});

test('computes clamped redaction bounds and aligns mosaic bounds to the block grid', async () => {
  const { redactionBounds } = await import('../src/screenshot-annotations.js');
  const size = { width: 400, height: 300 };
  // Multi-point path grown by half the brush width (46 / 2 = 23).
  assert.deepEqual(
    redactionBounds({ tool: 'blur', lineWidth: 6, points: [{ x: 100, y: 80 }, { x: 200, y: 160 }] }, size),
    { x: 77, y: 57, width: 146, height: 126 },
  );
  // Single point → a brush-width square centered on the point.
  assert.deepEqual(
    redactionBounds({ tool: 'blur', lineWidth: 3, points: [{ x: 100, y: 100 }] }, size),
    { x: 87, y: 87, width: 26, height: 26 },
  );
  // Clamped to the image edges.
  assert.deepEqual(
    redactionBounds({ tool: 'blur', lineWidth: 10, points: [{ x: 5, y: 5 }] }, size),
    { x: 0, y: 0, width: 42, height: 42 },
  );
  // Mosaic snaps outward onto the global 14px block grid.
  const mosaicBounds = redactionBounds(
    { tool: 'mosaic', lineWidth: 6, points: [{ x: 100, y: 80 }, { x: 200, y: 160 }] },
    size,
  );
  assert.deepEqual(mosaicBounds, { x: 70, y: 56, width: 154, height: 140 });
  assert.equal(mosaicBounds.x % 14, 0);
  assert.equal(mosaicBounds.y % 14, 0);
});

function createMockContext() {
  const calls = [];
  const draws = [];
  const stack = [];
  const context = {
    imageSmoothingEnabled: true,
    globalCompositeOperation: 'source-over',
    filter: 'none',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    save() { calls.push('save'); stack.push(snapshotState()); },
    restore() {
      calls.push('restore');
      const state = stack.pop();
      if (state) Object.assign(context, state);
    },
    beginPath() { calls.push('beginPath'); },
    moveTo(x, y) { calls.push(`moveTo(${x},${y})`); },
    lineTo(x, y) { calls.push(`lineTo(${x},${y})`); },
    stroke() { calls.push(`stroke(${context.lineWidth})`); },
    translate(x, y) { calls.push(`translate(${x},${y})`); },
    drawImage(...args) {
      calls.push('drawImage');
      draws.push({
        args,
        imageSmoothingEnabled: context.imageSmoothingEnabled,
        filter: context.filter,
        globalCompositeOperation: context.globalCompositeOperation,
      });
    },
  };
  function snapshotState() {
    return {
      imageSmoothingEnabled: context.imageSmoothingEnabled,
      globalCompositeOperation: context.globalCompositeOperation,
      filter: context.filter,
      lineCap: context.lineCap,
      lineJoin: context.lineJoin,
      lineWidth: context.lineWidth,
      strokeStyle: context.strokeStyle,
      fillStyle: context.fillStyle,
      globalAlpha: context.globalAlpha,
    };
  }
  context.__calls = calls;
  context.__draws = draws;
  return context;
}

function createMockCanvasFactory() {
  const canvases = [];
  return {
    canvases,
    create(width, height) {
      const context = createMockContext();
      const canvas = { width, height, context, getContext: () => context };
      canvases.push(canvas);
      return canvas;
    },
  };
}

test('renders mosaic strokes via downsample, nearest-neighbor upscale, and brush mask', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const main = createMockContext();
  const factory = createMockCanvasFactory();
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const penStroke = { tool: 'pen', color: '#ef493f', lineWidth: 6, points: [{ x: 10, y: 20 }, { x: 60, y: 20 }] };
  const mosaicStroke = { tool: 'mosaic', color: '#ef493f', lineWidth: 6, points: [{ x: 100, y: 80 }, { x: 200, y: 160 }] };

  renderStrokes(main, [penStroke, mosaicStroke], { source, createCanvas: factory.create });

  assert.equal(factory.canvases.length, 2);
  const [small, effect] = factory.canvases;
  assert.equal(small.width, 11);
  assert.equal(small.height, 10);
  assert.equal(effect.width, 154);
  assert.equal(effect.height, 140);

  // Downsample pass: averaged sampling of the bounds region from the source.
  assert.deepEqual(small.context.__draws, [{
    args: [source, 70, 56, 154, 140, 0, 0, 11, 10],
    imageSmoothingEnabled: true,
    filter: 'none',
    globalCompositeOperation: 'source-over',
  }]);
  // Upscale pass: nearest-neighbor back to full bounds size.
  assert.deepEqual(effect.context.__draws, [{
    args: [small, 0, 0, 11, 10, 0, 0, 154, 140],
    imageSmoothingEnabled: false,
    filter: 'none',
    globalCompositeOperation: 'source-over',
  }]);
  // Mask pass keeps only the brush coverage, then state is restored.
  assert.deepEqual(effect.context.__calls, [
    'drawImage', 'save', 'translate(-70,-56)', 'beginPath', 'moveTo(100,80)', 'lineTo(200,160)', 'stroke(46)', 'restore',
  ]);
  assert.equal(effect.context.globalCompositeOperation, 'source-over');
  assert.equal(effect.context.imageSmoothingEnabled, true);
  assert.equal(effect.context.filter, 'none');
  // Redaction pastes after the earlier pen stroke, covering it.
  const mainDrawIndex = main.__calls.indexOf('drawImage');
  assert.ok(main.__calls.indexOf('stroke') < mainDrawIndex);
  assert.deepEqual(main.__draws, [{ args: [effect, 70, 56], imageSmoothingEnabled: true, filter: 'none', globalCompositeOperation: 'source-over' }]);

  // A single-point click still produces a full mosaic dot.
  const dot = { tool: 'mosaic', lineWidth: 3, points: [{ x: 100, y: 100 }] };
  const dotFactory = createMockCanvasFactory();
  const dotMain = createMockContext();
  renderStrokes(dotMain, [dot], { source, createCanvas: dotFactory.create });
  const [dotSmall, dotEffect] = dotFactory.canvases;
  assert.equal(dotSmall.width, 5);
  assert.equal(dotEffect.width, 40);
  assert.deepEqual(dotEffect.context.__calls, [
    'drawImage', 'save', 'translate(-80,-80)', 'beginPath', 'moveTo(100,100)', 'lineTo(100,100)', 'stroke(26)', 'restore',
  ]);
  assert.deepEqual(dotMain.__draws[0].args, [dotEffect, 80, 80]);
});

test('renders blur strokes from a padded sample region and resets the filter', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const stroke = { tool: 'blur', lineWidth: 6, points: [{ x: 150, y: 120 }, { x: 250, y: 200 }] };

  const factory = createMockCanvasFactory();
  const main = createMockContext();
  renderStrokes(main, [stroke], { source, createCanvas: factory.create });

  assert.equal(factory.canvases.length, 1);
  const [effect] = factory.canvases;
  // Sample region = bounds (127,97,146,126) padded by 2 × radius (20).
  assert.equal(effect.width, 186);
  assert.equal(effect.height, 166);
  assert.deepEqual(effect.context.__draws, [{
    args: [source, 107, 77, 186, 166, 0, 0, 186, 166],
    imageSmoothingEnabled: true,
    filter: 'blur(10px)',
    globalCompositeOperation: 'source-over',
  }]);
  assert.equal(effect.context.filter, 'none');
  assert.deepEqual(effect.context.__calls, [
    'drawImage', 'save', 'translate(-107,-77)', 'beginPath', 'moveTo(150,120)', 'lineTo(250,200)', 'stroke(46)', 'restore',
  ]);
  assert.deepEqual(main.__draws[0].args, [effect, 107, 77]);

  // Padding clamps to the image edges for strokes near the border.
  const edgeStroke = { tool: 'blur', lineWidth: 3, points: [{ x: 390, y: 290 }] };
  const edgeFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [edgeStroke], { source, createCanvas: edgeFactory.create });
  const [edgeEffect] = edgeFactory.canvases;
  assert.deepEqual(edgeEffect.context.__draws[0].args, [source, 365, 265, 35, 35, 0, 0, 35, 35]);
});

test('skips redaction strokes without a source or canvas factory instead of throwing', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const main = createMockContext();
  const strokes = [{ tool: 'mosaic', lineWidth: 6, points: [{ x: 100, y: 80 }, { x: 200, y: 160 }] }];
  renderStrokes(main, strokes);
  renderStrokes(main, strokes, {});
  renderStrokes(main, strokes, { source: { naturalWidth: 400, naturalHeight: 300 } });
  assert.equal(main.__draws.length, 0);
});

test('caches redaction effect canvases per stroke and source until invalidated', async () => {
  const { renderStrokes, invalidateRedactionCache } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const stroke = { tool: 'blur', lineWidth: 6, points: [{ x: 150, y: 120 }, { x: 250, y: 200 }] };

  const firstFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: firstFactory.create });
  assert.equal(firstFactory.canvases.length, 1);

  // Same stroke + same source → served from cache, no new canvases.
  const secondFactory = createMockCanvasFactory();
  const secondMain = createMockContext();
  renderStrokes(secondMain, [stroke], { source, createCanvas: secondFactory.create });
  assert.equal(secondFactory.canvases.length, 0);
  assert.equal(secondMain.__draws.length, 1);

  // A different source object must not reuse the cached effect.
  const otherFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source: { naturalWidth: 400, naturalHeight: 300 }, createCanvas: otherFactory.create });
  assert.equal(otherFactory.canvases.length, 1);

  // After invalidation the effect is rebuilt.
  invalidateRedactionCache(stroke);
  const thirdFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: thirdFactory.create });
  assert.equal(thirdFactory.canvases.length, 1);

  // Invalidating an unknown stroke is a no-op.
  invalidateRedactionCache({ tool: 'blur', lineWidth: 6, points: [] });
});

test('old two-argument renderStrokes calls keep pen rendering and skip redactions silently', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const main = createMockContext();
  const strokes = [
    { tool: 'pen', color: '#ef493f', lineWidth: 6, points: [{ x: 10, y: 20 }, { x: 60, y: 20 }] },
    { tool: 'mosaic', color: '#ef493f', lineWidth: 6, points: [{ x: 100, y: 80 }, { x: 200, y: 160 }] },
    { tool: 'blur', color: '#ef493f', lineWidth: 6, points: [{ x: 150, y: 120 }] },
  ];
  renderStrokes(main, strokes);
  assert.deepEqual(main.__calls.filter((call) => call.startsWith('moveTo') || call.startsWith('lineTo')), ['moveTo(10,20)', 'lineTo(60,20)']);
  assert.equal(main.__draws.length, 0);
});

test('redaction strokes with empty or missing points render nothing and bounds collapse to zero', async () => {
  const { renderStrokes, redactionBounds } = await import('../src/screenshot-annotations.js');
  const main = createMockContext();
  const factory = createMockCanvasFactory();
  const source = { naturalWidth: 400, naturalHeight: 300 };
  renderStrokes(main, [
    { tool: 'mosaic', lineWidth: 6, points: [] },
    { tool: 'blur', lineWidth: 6 },
  ], { source, createCanvas: factory.create });
  assert.equal(main.__draws.length, 0);
  assert.equal(factory.canvases.length, 0);
  const bounds = redactionBounds({ tool: 'mosaic', lineWidth: 6, points: [] }, { width: 400, height: 300 });
  assert.equal(bounds.width, 0);
  assert.equal(bounds.height, 0);
});

test('a bounds change alone rebuilds the cached effect even without explicit invalidation', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const stroke = { tool: 'blur', lineWidth: 6, points: [{ x: 150, y: 120 }, { x: 250, y: 200 }] };

  const firstFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: firstFactory.create });
  assert.equal(firstFactory.canvases.length, 1);
  const staleWidth = firstFactory.canvases[0].width;

  // Growing the stroke beyond the old bounding box must not reuse the stale effect.
  stroke.points.push({ x: 300, y: 260 });
  const grownFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: grownFactory.create });
  assert.equal(grownFactory.canvases.length, 1);
  assert.ok(grownFactory.canvases[0].width > staleWidth);
  assert.equal(grownFactory.canvases[0].width, 236);
  assert.equal(grownFactory.canvases[0].height, 223);
});

test('effects beyond the 4096x4096 cache cap still render but are never cached', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 5000, naturalHeight: 4000 };
  const stroke = { tool: 'mosaic', lineWidth: 10, points: [{ x: 0, y: 0 }, { x: 4999, y: 3999 }] };

  const firstFactory = createMockCanvasFactory();
  const firstMain = createMockContext();
  renderStrokes(firstMain, [stroke], { source, createCanvas: firstFactory.create });
  assert.equal(firstFactory.canvases.length, 2);
  assert.equal(firstMain.__draws.length, 1);

  // Not cached: a second render builds brand-new canvases and still pastes once.
  const secondFactory = createMockCanvasFactory();
  const secondMain = createMockContext();
  renderStrokes(secondMain, [stroke], { source, createCanvas: secondFactory.create });
  assert.equal(secondFactory.canvases.length, 2);
  assert.equal(secondMain.__draws.length, 1);
  assert.equal(secondFactory.canvases[1].width, 5000);
});

test('mosaic bounds near the right and bottom edges stay grid-aligned and clamped', async () => {
  const { redactionBounds } = await import('../src/screenshot-annotations.js');
  const size = { width: 400, height: 300 };
  const bounds = redactionBounds(
    { tool: 'mosaic', lineWidth: 6, points: [{ x: 390, y: 280 }, { x: 395, y: 285 }] },
    size,
  );
  assert.deepEqual(bounds, { x: 364, y: 252, width: 36, height: 48 });
  assert.equal(bounds.x % 14, 0);
  assert.equal(bounds.y % 14, 0);
  assert.ok(bounds.x + bounds.width <= size.width);
  assert.ok(bounds.y + bounds.height <= size.height);
});

test('blur padding clamps to the image at the top-left corner', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const stroke = { tool: 'blur', lineWidth: 10, points: [{ x: 10, y: 10 }] };
  const factory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: factory.create });
  const [effect] = factory.canvases;
  assert.equal(effect.width, 79);
  assert.equal(effect.height, 79);
  assert.deepEqual(effect.context.__draws[0].args, [source, 0, 0, 79, 79, 0, 0, 79, 79]);
});

test('undo/redo idempotency re-pastes the identical cached effect canvas', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const stroke = { tool: 'blur', lineWidth: 6, points: [{ x: 150, y: 120 }, { x: 250, y: 200 }] };

  const firstFactory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: firstFactory.create });
  const effect = firstFactory.canvases[0];

  // Simulate undo then redo: the same stroke object renders again and must
  // paste the very same effect bitmap at the very same position.
  const secondMain = createMockContext();
  renderStrokes(secondMain, [stroke], { source, createCanvas: createMockCanvasFactory().create });
  assert.equal(secondMain.__draws[0].args[0], effect);
  assert.deepEqual(secondMain.__draws[0].args, [effect, 107, 77]);
});

test('redaction leaves the main context filter and composite operation untouched', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const factory = createMockCanvasFactory();
  const main = createMockContext();
  renderStrokes(main, [
    { tool: 'mosaic', lineWidth: 6, points: [{ x: 100, y: 80 }, { x: 200, y: 160 }] },
    { tool: 'blur', lineWidth: 6, points: [{ x: 150, y: 120 }, { x: 250, y: 200 }] },
  ], { source, createCanvas: factory.create });
  assert.equal(main.filter, 'none');
  assert.equal(main.globalCompositeOperation, 'source-over');
  assert.ok(main.__draws.length >= 2);
});

test('fractional stroke coordinates produce integer blur sample regions', async () => {
  const { renderStrokes } = await import('../src/screenshot-annotations.js');
  const source = { naturalWidth: 400, naturalHeight: 300 };
  const stroke = { tool: 'blur', lineWidth: 6, points: [{ x: 100.5, y: 80.25 }, { x: 200.75, y: 160.5 }] };
  const factory = createMockCanvasFactory();
  renderStrokes(createMockContext(), [stroke], { source, createCanvas: factory.create });
  const [effect] = factory.canvases;
  assert.ok(Number.isInteger(effect.width));
  assert.ok(Number.isInteger(effect.height));
  assert.deepEqual(effect.context.__draws[0].args, [source, 57, 37, 187, 167, 0, 0, 187, 167]);
});


