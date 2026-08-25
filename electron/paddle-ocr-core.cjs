const DEFAULT_MIN_LINE_CONFIDENCE = 0.8;

function lineBounds(line) {
  const points = Array.isArray(line?.box) ? line.box : [];
  const xs = points.map((point) => Number(point?.[0])).filter(Number.isFinite);
  const ys = points.map((point) => Number(point?.[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

function characterWeight(character) {
  if (/\s/u.test(character)) return 0.48;
  if (/[\u3400-\u9fff\u3000-\u303f\uff01-\uff60]/u.test(character)) return 1;
  if (/[A-Z0-9]/u.test(character)) return 0.64;
  if (/[a-z]/u.test(character)) return 0.52;
  return 0.46;
}

function wordIdsForText(text, nextWordId) {
  const ids = new Map();
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  for (const segment of segmenter.segment(text)) {
    if (!segment.segment.trim()) continue;
    const wordId = nextWordId.value++;
    for (let offset = 0; offset < segment.segment.length;) {
      ids.set(segment.index + offset, wordId);
      offset += String.fromCodePoint(segment.segment.codePointAt(offset)).length;
    }
  }
  return ids;
}

function flattenPaddleLines(lines, { minConfidence = DEFAULT_MIN_LINE_CONFIDENCE } = {}) {
  const prepared = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      text: String(line?.text || '').trim(),
      confidence: Number(line?.mean) || 0,
      bbox: lineBounds(line),
    }))
    .filter((line) => line.text && line.bbox)
    .sort((left, right) => left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0);
  const strong = prepared.filter((line) => line.confidence >= minConfidence);
  const selectedLines = strong.length ? strong : prepared.filter((line) => line.confidence >= 0.55);
  const items = [];
  const retainedLines = [];
  const nextWordId = { value: 0 };

  selectedLines.forEach((line, lineId) => {
    const characters = [];
    for (let offset = 0; offset < line.text.length;) {
      const character = String.fromCodePoint(line.text.codePointAt(offset));
      characters.push({ character, offset, weight: characterWeight(character) });
      offset += character.length;
    }
    const totalWeight = characters.reduce((sum, item) => sum + item.weight, 0) || 1;
    const wordIds = wordIdsForText(line.text, nextWordId);
    const width = line.bbox.x1 - line.bbox.x0;
    let consumedWeight = 0;
    let pendingSpace = false;
    let lineHasItems = false;
    for (const entry of characters) {
      const x0 = line.bbox.x0 + width * consumedWeight / totalWeight;
      consumedWeight += entry.weight;
      const x1 = line.bbox.x0 + width * consumedWeight / totalWeight;
      if (/\s/u.test(entry.character)) {
        pendingSpace = lineHasItems;
        continue;
      }
      items.push({
        text: entry.character,
        prefix: items.length === 0 ? '' : !lineHasItems ? '\n' : pendingSpace ? ' ' : '',
        lineId,
        wordId: wordIds.get(entry.offset) ?? nextWordId.value++,
        bbox: { x0, y0: line.bbox.y0, x1, y1: line.bbox.y1 },
      });
      pendingSpace = false;
      lineHasItems = true;
    }
    if (lineHasItems) retainedLines.push(line);
  });

  const confidence = retainedLines.length
    ? retainedLines.reduce((sum, line) => sum + line.confidence, 0) / retainedLines.length * 100
    : 0;
  return {
    text: retainedLines.map((line) => line.text).join('\n'),
    confidence,
    items,
  };
}

function createPaddleOcrService({ factory } = {}) {
  let servicePromise;
  let queue = Promise.resolve();

  function getService() {
    if (!servicePromise) {
      servicePromise = (factory
        ? Promise.resolve().then(() => factory())
        : import('@gutenye/ocr-node').then(({ default: Ocr }) => Ocr.create({
            onnxOptions: { executionProviders: ['cpu'] },
          })))
        .catch((error) => {
          servicePromise = null;
          throw error;
        });
    }
    return servicePromise;
  }

  function recognize(imagePath) {
    const job = queue.catch(() => {}).then(async () => {
      const service = await getService();
      return flattenPaddleLines(await service.detect(imagePath));
    });
    queue = job;
    return job;
  }

  function terminate() {
    servicePromise = null;
  }

  return { recognize, terminate };
}

module.exports = {
  createPaddleOcrService,
  flattenPaddleLines,
  lineBounds,
};
