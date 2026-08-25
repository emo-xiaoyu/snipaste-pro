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

export function renderStrokes(context, strokes) {
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.lineWidth = stroke.lineWidth;
    if (stroke.tool === 'pen') {
      context.beginPath();
      stroke.points.forEach((item, index) => index ? context.lineTo(item.x, item.y) : context.moveTo(item.x, item.y));
      context.stroke();
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
