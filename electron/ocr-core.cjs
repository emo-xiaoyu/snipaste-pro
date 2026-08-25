const fs = require('node:fs');
const path = require('node:path');
const { createWorker, OEM, PSM } = require('tesseract.js');

const DEFAULT_LANGUAGE_SOURCES = Object.freeze([
  {
    code: 'chi_sim',
    source: path.join(require('@tesseract.js-data/chi_sim').langPath, 'chi_sim.traineddata.gz'),
  },
  {
    code: 'eng',
    source: path.join(require('@tesseract.js-data/eng').langPath, 'eng.traineddata.gz'),
  },
]);

function normalizeOcrText(value) {
  return String(value || '')
    .replace(/\f/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/([\u3400-\u9fff])[\t ]+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ocrResultScore(result) {
  const text = String(result?.text || '');
  const usefulCharacters = (text.match(/[\p{L}\p{N}\u3400-\u9fff]/gu) || []).length;
  const suspiciousCharacters = (text.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
  const hasSelectableItems = Array.isArray(result?.items) && result.items.length > 0;
  return (Number(result?.confidence) || 0)
    + Math.min(8, usefulCharacters / 20)
    - suspiciousCharacters * 8
    - (hasSelectableItems ? 0 : 40);
}

function selectBetterOcrResult(primary, alternate) {
  return ocrResultScore(alternate) > ocrResultScore(primary) ? alternate : primary;
}

function flattenOcrBlocks(blocks) {
  const items = [];
  let lineId = 0;
  let wordId = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const paragraph of block?.paragraphs || []) {
      for (const line of paragraph?.lines || []) {
        const lineStart = items.length;
        for (const word of line?.words || []) {
          const wordStart = items.length;
          const symbols = word?.symbols?.length ? word.symbols : [{ text: word?.text, bbox: word?.bbox }];
          for (const symbol of symbols) {
            const text = String(symbol?.text || '').replace(/\s/g, '');
            const bbox = symbol?.bbox;
            if (!text || !bbox || ![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite)) continue;
            const width = bbox.x1 - bbox.x0;
            if (width <= 0 || bbox.y1 <= bbox.y0) continue;
            [...text].forEach((character, characterIndex, characters) => {
              const x0 = bbox.x0 + width * characterIndex / characters.length;
              const x1 = bbox.x0 + width * (characterIndex + 1) / characters.length;
              items.push({
                text: character,
                prefix: items.length === 0 ? '' : items.length === lineStart ? '\n' : items.length === wordStart ? ' ' : '',
                lineId,
                wordId,
                bbox: { x0, y0: bbox.y0, x1, y1: bbox.y1 },
              });
            });
          }
          if (items.length > wordStart) wordId += 1;
        }
        if (items.length > lineStart) lineId += 1;
      }
    }
  }
  return items;
}

function prepareLanguageData(dataDir, languageSources = DEFAULT_LANGUAGE_SOURCES) {
  const languageDir = path.join(dataDir, 'languages');
  fs.mkdirSync(languageDir, { recursive: true });
  for (const language of languageSources) {
    const target = path.join(languageDir, `${language.code}.traineddata.gz`);
    const sourceSize = fs.statSync(language.source).size;
    const targetSize = fs.existsSync(target) ? fs.statSync(target).size : -1;
    if (sourceSize !== targetSize) fs.copyFileSync(language.source, target);
  }
  return languageDir;
}

function createOcrService({
  dataDir,
  languageSources = DEFAULT_LANGUAGE_SOURCES,
  workerFactory = createWorker,
  logger,
} = {}) {
  if (!dataDir) throw new Error('OCR data directory is required');
  let workerPromise = null;
  let queue = Promise.resolve();

  function getWorker() {
    if (!workerPromise) {
      const languageDir = prepareLanguageData(dataDir, languageSources);
      const cachePath = path.join(dataDir, 'cache');
      fs.mkdirSync(cachePath, { recursive: true });
      workerPromise = workerFactory(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
        langPath: languageDir,
        cachePath,
        cacheMethod: 'write',
        gzip: true,
        ...(typeof logger === 'function' ? { logger } : {}),
      }).then(async (worker) => {
        await worker.setParameters({
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: PSM.AUTO,
          user_defined_dpi: '300',
        });
        return worker;
      }).catch((error) => {
        workerPromise = null;
        throw error;
      });
    }
    return workerPromise;
  }

  function recognize(image) {
    const job = queue.catch(() => {}).then(async () => {
      const worker = await getWorker();
      const recognizeOnce = async () => {
        const result = await worker.recognize(image, {}, { text: true, blocks: true });
        return {
          text: normalizeOcrText(result?.data?.text),
          confidence: Number(result?.data?.confidence) || 0,
          items: flattenOcrBlocks(result?.data?.blocks),
        };
      };
      const primary = await recognizeOnce();
      if (primary.confidence >= 82 && primary.items.length) return primary;
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        const alternate = await recognizeOnce();
        return selectBetterOcrResult(primary, alternate);
      } finally {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      }
    });
    queue = job;
    return job;
  }

  async function terminate() {
    if (!workerPromise) return;
    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch {}
    workerPromise = null;
  }

  return { recognize, terminate };
}

module.exports = {
  createOcrService,
  flattenOcrBlocks,
  normalizeOcrText,
  ocrResultScore,
  prepareLanguageData,
  selectBetterOcrResult,
};
