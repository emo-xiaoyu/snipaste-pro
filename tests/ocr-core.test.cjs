const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createOcrService,
  flattenOcrBlocks,
  normalizeOcrText,
  selectBetterOcrResult,
} = require('../electron/ocr-core.cjs');

test('normalizes OCR output while preserving useful line breaks and numbers', () => {
  assert.equal(
    normalizeOcrText(' 订单  2026-0814\r\n\r\n\r\n合 计\t 128.50 元\f '),
    '订单 2026-0814\n\n合计 128.50 元',
  );
});

test('flattens OCR symbols into ordered selectable characters', () => {
  const items = flattenOcrBlocks([{ paragraphs: [{ lines: [
    { words: [
      { text: '订单', bbox: { x0: 10, y0: 20, x1: 50, y1: 40 }, symbols: [
        { text: '订', bbox: { x0: 10, y0: 20, x1: 30, y1: 40 } },
        { text: '单', bbox: { x0: 30, y0: 20, x1: 50, y1: 40 } },
      ] },
      { text: '128', bbox: { x0: 60, y0: 20, x1: 90, y1: 40 }, symbols: [] },
    ] },
    { words: [{ text: '完成', bbox: { x0: 10, y0: 48, x1: 50, y1: 68 }, symbols: [] }] },
  ] }] }]);
  assert.deepEqual(items.map(({ text, prefix, lineId, wordId }) => ({ text, prefix, lineId, wordId })), [
    { text: '订', prefix: '', lineId: 0, wordId: 0 },
    { text: '单', prefix: '', lineId: 0, wordId: 0 },
    { text: '1', prefix: ' ', lineId: 0, wordId: 1 },
    { text: '2', prefix: '', lineId: 0, wordId: 1 },
    { text: '8', prefix: '', lineId: 0, wordId: 1 },
    { text: '完', prefix: '\n', lineId: 1, wordId: 2 },
    { text: '成', prefix: '', lineId: 1, wordId: 2 },
  ]);
});

test('prefers the OCR pass with stronger confidence and selectable text', () => {
  const weak = { text: '淈码', confidence: 41, items: [{ text: '淈' }] };
  const strong = { text: '中文', confidence: 88, items: [{ text: '中' }, { text: '文' }] };
  assert.equal(selectBetterOcrResult(weak, strong), strong);
  assert.equal(selectBetterOcrResult(strong, { text: '', confidence: 99, items: [] }), strong);
});

test('retries low-confidence OCR with sparse layout analysis', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasty-ocr-retry-test-'));
  const languageDir = path.join(dataDir, 'fixtures');
  fs.mkdirSync(languageDir);
  const languageSources = ['chi_sim', 'eng'].map((code) => {
    const source = path.join(languageDir, `${code}.traineddata.gz`);
    fs.writeFileSync(source, code);
    return { code, source };
  });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const parameterCalls = [];
  let recognitionCount = 0;
  const block = (text) => [{ paragraphs: [{ lines: [{ words: [{
    text,
    bbox: { x0: 0, y0: 0, x1: 20, y1: 20 },
    symbols: [...text].map((character, index) => ({
      text: character,
      bbox: { x0: index * 10, y0: 0, x1: index * 10 + 10, y1: 20 },
    })),
  }] }] }] }];
  const worker = {
    setParameters: async (value) => { parameterCalls.push(value); },
    recognize: async () => {
      recognitionCount += 1;
      return recognitionCount === 1
        ? { data: { text: '淈码', confidence: 38, blocks: block('淈码') } }
        : { data: { text: '中文', confidence: 91, blocks: block('中文') } };
    },
    terminate: async () => {},
  };
  const service = createOcrService({ dataDir, languageSources, workerFactory: async () => worker });
  const result = await service.recognize('image');
  assert.equal(result.text, '中文');
  assert.equal(recognitionCount, 2);
  assert.equal(parameterCalls.at(-2).tessedit_pageseg_mode, '11');
  assert.equal(parameterCalls.at(-1).tessedit_pageseg_mode, '3');
  await service.terminate();
});

test('serializes OCR work so multiple pins do not recognize concurrently', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasty-ocr-test-'));
  const languageDir = path.join(dataDir, 'fixtures');
  fs.mkdirSync(languageDir);
  const languageSources = ['chi_sim', 'eng'].map((code) => {
    const source = path.join(languageDir, `${code}.traineddata.gz`);
    fs.writeFileSync(source, code);
    return { code, source };
  });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let active = 0;
  let maximumActive = 0;
  const parameterCalls = [];
  const worker = {
    setParameters: async (value) => { parameterCalls.push(value); },
    recognize: async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { data: { text: `结果 ${value}`, confidence: 93 } };
    },
    terminate: async () => {},
  };
  const service = createOcrService({
    dataDir,
    languageSources,
    workerFactory: async () => worker,
  });
  const results = await Promise.all([service.recognize('A1'), service.recognize('B2')]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(results.map((item) => item.text), ['结果 A1', '结果 B2']);
  assert.equal(parameterCalls[0].tessedit_pageseg_mode, '3');
  assert.equal(parameterCalls[0].user_defined_dpi, '300');
  assert.equal(parameterCalls.at(-1).tessedit_pageseg_mode, '3');
  await service.terminate();
});
