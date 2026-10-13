export const TEXT_FONT_FAMILY = '"Segoe UI Variable", "Microsoft YaHei UI", sans-serif';
export const TEXT_LINE_HEIGHT = 1.3;

export function normalizedRect(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function pointInsideRect(point, rect) {
  return {
    x: clamp(point.x, rect.x, rect.x + rect.width),
    y: clamp(point.y, rect.y, rect.y + rect.height),
  };
}

export function textRectFromDrag(start, end, bounds, options = {}) {
  const minWidth = Number(options.minWidth) || 40;
  const minHeight = Number(options.minHeight) || 34;
  const dragged = normalizedRect(pointInsideRect(start, bounds), pointInsideRect(end, bounds));
  if (dragged.width >= minWidth && dragged.height >= minHeight) return dragged;
  const width = Math.min(Number(options.defaultWidth) || 240, bounds.width);
  const height = Math.min(Number(options.defaultHeight) || 88, bounds.height);
  return {
    x: clamp(start.x, bounds.x, bounds.x + bounds.width - width),
    y: clamp(start.y, bounds.y, bounds.y + bounds.height - height),
    width,
    height,
  };
}

export function textFontSizeFromLineWidth(lineWidth) {
  if (lineWidth <= 3) return 18;
  if (lineWidth >= 10) return 36;
  return 24;
}

export function highlighterLineWidth(lineWidth) {
  if (lineWidth <= 3) return 14;
  if (lineWidth >= 10) return 32;
  return 22;
}

export function redactBrushWidth(lineWidth) {
  if (lineWidth <= 3) return 26;
  if (lineWidth >= 10) return 74;
  return 46;
}

export function mosaicBlockSize(lineWidth) {
  if (lineWidth <= 3) return 8;
  if (lineWidth >= 10) return 22;
  return 14;
}

export function blurRadius(lineWidth) {
  if (lineWidth <= 3) return 6;
  if (lineWidth >= 10) return 16;
  return 10;
}

// Sampling region of a redaction stroke: the points' bounding box grown by
// half the brush width, clamped to the image, and (for mosaic) snapped onto
// the global block grid so overlapping strokes tile seamlessly.
export function redactionBounds(stroke, size) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of stroke.points || []) {
    if (item.x < minX) minX = item.x;
    if (item.y < minY) minY = item.y;
    if (item.x > maxX) maxX = item.x;
    if (item.y > maxY) maxY = item.y;
  }
  const half = redactBrushWidth(stroke.lineWidth) / 2;
  let x = clamp(minX - half, 0, size.width);
  let y = clamp(minY - half, 0, size.height);
  let right = clamp(maxX + half, 0, size.width);
  let bottom = clamp(maxY + half, 0, size.height);
  if (stroke.tool === 'mosaic') {
    const block = mosaicBlockSize(stroke.lineWidth);
    x = Math.floor(x / block) * block;
    y = Math.floor(y / block) * block;
    right = Math.min(Math.ceil(right / block) * block, size.width);
    bottom = Math.min(Math.ceil(bottom / block) * block, size.height);
  }
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

const redactionCache = new WeakMap();
const MAX_CACHED_EFFECT_AREA = 4096 * 4096;

export function invalidateRedactionCache(stroke) {
  redactionCache.delete(stroke);
}

function createDomCanvas(width, height) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Redaction always samples the frozen source image, never the live canvas:
// overlapping strokes never compound, and undo/redo stays deterministic.
function renderRedactionStroke(context, stroke, options) {
  const source = options.source;
  if (!source || !stroke.points || !stroke.points.length) return;
  const size = {
    width: source.naturalWidth || source.width,
    height: source.naturalHeight || source.height,
  };
  if (!size.width || !size.height) return;
  const bounds = redactionBounds(stroke, size);
  if (bounds.width <= 0 || bounds.height <= 0) return;

  const cached = redactionCache.get(stroke);
  if (cached && cached.source === source
    && cached.bounds.x === bounds.x && cached.bounds.y === bounds.y
    && cached.bounds.width === bounds.width && cached.bounds.height === bounds.height) {
    context.drawImage(cached.canvas, cached.x, cached.y);
    return;
  }

  const createCanvas = options.createCanvas || createDomCanvas;
  let sampleX = bounds.x;
  let sampleY = bounds.y;
  let sampleWidth = bounds.width;
  let sampleHeight = bounds.height;
  let radius = 0;
  if (stroke.tool === 'blur') {
    // Pad the sample region so the gaussian kernel never samples past the
    // effect canvas edge; the extra ring is masked away below.
    radius = blurRadius(stroke.lineWidth);
    const pad = radius * 2;
    sampleX = Math.max(0, Math.floor(bounds.x - pad));
    sampleY = Math.max(0, Math.floor(bounds.y - pad));
    sampleWidth = Math.min(Math.ceil(bounds.x + bounds.width + pad), size.width) - sampleX;
    sampleHeight = Math.min(Math.ceil(bounds.y + bounds.height + pad), size.height) - sampleY;
  }
  if (sampleWidth <= 0 || sampleHeight <= 0) return;

  let small = null;
  if (stroke.tool === 'mosaic') {
    const block = mosaicBlockSize(stroke.lineWidth);
    const smallWidth = Math.max(1, Math.ceil(sampleWidth / block));
    const smallHeight = Math.max(1, Math.ceil(sampleHeight / block));
    small = createCanvas(smallWidth, smallHeight);
    if (!small) return;
    const sctx = small.getContext('2d');
    if (!sctx) return;
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(source, sampleX, sampleY, sampleWidth, sampleHeight, 0, 0, smallWidth, smallHeight);
  }

  const effect = createCanvas(sampleWidth, sampleHeight);
  if (!effect) return;
  const ectx = effect.getContext('2d');
  if (!ectx) return;

  if (small) {
    ectx.imageSmoothingEnabled = false;
    ectx.drawImage(small, 0, 0, small.width, small.height, 0, 0, sampleWidth, sampleHeight);
    ectx.imageSmoothingEnabled = true;
  } else {
    ectx.filter = `blur(${radius}px)`;
    ectx.drawImage(source, sampleX, sampleY, sampleWidth, sampleHeight, 0, 0, sampleWidth, sampleHeight);
    ectx.filter = 'none';
  }

  ectx.save();
  ectx.globalCompositeOperation = 'destination-in';
  ectx.translate(-sampleX, -sampleY);
  ectx.lineCap = 'round';
  ectx.lineJoin = 'round';
  ectx.lineWidth = redactBrushWidth(stroke.lineWidth);
  ectx.strokeStyle = '#000';
  ectx.beginPath();
  if (stroke.points.length === 1) {
    ectx.moveTo(stroke.points[0].x, stroke.points[0].y);
    ectx.lineTo(stroke.points[0].x, stroke.points[0].y);
  } else {
    stroke.points.forEach((item, index) => index ? ectx.lineTo(item.x, item.y) : ectx.moveTo(item.x, item.y));
  }
  ectx.stroke();
  ectx.restore();

  if (sampleWidth * sampleHeight <= MAX_CACHED_EFFECT_AREA) {
    redactionCache.set(stroke, { canvas: effect, x: sampleX, y: sampleY, source, bounds });
  }
  context.drawImage(effect, sampleX, sampleY);
}

export function rgbToHsl(r, g, b) {
  const red = clamp(r, 0, 255) / 255;
  const green = clamp(g, 0, 255) / 255;
  const blue = clamp(b, 0, 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case red:
        h = (green - blue) / d + (green < blue ? 6 : 0);
        break;
      case green:
        h = (blue - red) / d + 2;
        break;
      case blue:
        h = (red - green) / d + 4;
        break;
    }
    h = Math.round(h * 60);
  }
  return {
    h: (h + 360) % 360,
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function formatColorValue(pixel, format = 'hex') {
  if (!pixel) return '';
  const r = clamp(Math.round(pixel.r ?? 0), 0, 255);
  const g = clamp(Math.round(pixel.g ?? 0), 0, 255);
  const b = clamp(Math.round(pixel.b ?? 0), 0, 255);
  const hex = pixel.hex || `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

  if (format === 'rgb') {
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (format === 'hsl') {
    const { h, s, l } = rgbToHsl(r, g, b);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  return hex;
}

function appendToken(lines, line, token, maxWidth, measureText) {
  let nextLine = line;
  for (const character of token) {
    const candidate = `${nextLine}${character}`;
    if (nextLine && measureText(candidate) > maxWidth) {
      lines.push(nextLine);
      nextLine = character;
    } else {
      nextLine = candidate;
    }
  }
  return nextLine;
}

export function wrapTextLines(text, maxWidth, measureText) {
  const width = Math.max(1, Number(maxWidth) || 1);
  const paragraphs = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const tokens = paragraph.match(/\s+|[\u3400-\u9fff\uf900-\ufaff]|[^\s\u3400-\u9fff\uf900-\ufaff]+/gu) || [];
    let line = '';
    for (const token of tokens) {
      const candidate = `${line}${token}`;
      if (!line || measureText(candidate) <= width) {
        line = candidate;
        continue;
      }
      lines.push(line.trimEnd());
      line = measureText(token) <= width
        ? token.trimStart()
        : appendToken(lines, '', token.trimStart(), width, measureText);
    }
    lines.push(line);
  }
  return lines;
}

export function renderStrokes(context, strokes, options = {}) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = stroke.lineWidth;
    if (stroke.tool === 'pen') {
      context.beginPath();
      if (stroke.points.length === 1) {
        context.moveTo(stroke.points[0].x, stroke.points[0].y);
        context.lineTo(stroke.points[0].x, stroke.points[0].y);
      } else {
        stroke.points.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y));
      }
      context.stroke();
    } else if (stroke.tool === 'highlighter') {
      context.save();
      context.globalAlpha = Number.isFinite(stroke.globalAlpha) ? stroke.globalAlpha : 0.38;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.lineWidth = stroke.highlighterWidth || highlighterLineWidth(stroke.lineWidth);
      context.beginPath();
      if (stroke.points.length === 1) {
        context.moveTo(stroke.points[0].x, stroke.points[0].y);
        context.lineTo(stroke.points[0].x, stroke.points[0].y);
      } else {
        stroke.points.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y));
      }
      context.stroke();
      context.restore();
    } else if (stroke.tool === 'mosaic' || stroke.tool === 'blur') {
      renderRedactionStroke(context, stroke, options);
    } else if (stroke.tool === 'rect') {
      const rect = normalizedRect(stroke.start, stroke.end);
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    } else if (stroke.tool === 'ellipse') {
      const rect = normalizedRect(stroke.start, stroke.end);
      context.beginPath();
      context.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
      context.stroke();
    } else if (stroke.tool === 'arrow') {
      const { start, end } = stroke;
      const angle = Math.atan2(end.y - start.y, end.x - start.x);
      const head = Math.max(14, stroke.lineWidth * 4);
      context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
      context.beginPath(); context.moveTo(end.x, end.y); context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6)); context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6)); context.closePath(); context.fill();
    } else if (stroke.tool === 'text') {
      const rect = stroke.rect || normalizedRect(stroke.start, stroke.end);
      const fontSize = Math.max(12, Number(stroke.fontSize) || 24);
      const padding = Math.max(4, Math.round(fontSize * .24));
      const lineHeight = fontSize * TEXT_LINE_HEIGHT;
      context.save();
      context.beginPath();
      context.rect(rect.x, rect.y, rect.width, rect.height);
      context.clip();
      context.fillStyle = stroke.color;
      context.font = `600 ${fontSize}px ${TEXT_FONT_FAMILY}`;
      context.textBaseline = 'top';
      const lines = wrapTextLines(stroke.text, rect.width - padding * 2, (value) => context.measureText(value).width);
      lines.forEach((line, index) => {
        const y = rect.y + padding + index * lineHeight;
        if (y + fontSize <= rect.y + rect.height) context.fillText(line, rect.x + padding, y);
      });
      context.restore();
    }
  }
}
