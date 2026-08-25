const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOcrService } = require('../electron/ocr-core.cjs');

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Pass an existing image path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasty-ocr-verify-'));
  const service = createOcrService({ dataDir });
  const startedAt = Date.now();
  try {
    const result = await service.recognize(imagePath);
    process.stdout.write(`${JSON.stringify({
      success: Boolean(result.text),
      charCount: result.text.length,
      selectableItemCount: result.items.length,
      confidence: Math.round(result.confidence),
      hasChinese: /[\u3400-\u9fff]/.test(result.text),
      hasLatin: /[a-z]/i.test(result.text),
      hasDigit: /\d/.test(result.text),
      elapsedMs: Date.now() - startedAt,
    })}\n`);
  } finally {
    await service.terminate();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
