const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const { createOcrService } = require('../electron/ocr-core.cjs');
let stage = 'startup';

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Pass an existing image path');
  await app.whenReady();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasty-chinese-ocr-'));
  const service = createOcrService({ dataDir });
  try {
    stage = 'load fixture';
    let source = nativeImage.createFromPath(path.resolve(imagePath));
    if (source.isEmpty()) throw new Error('Could not load OCR fixture image');
    const cropValues = process.argv.slice(3, 7).map(Number);
    if (cropValues.length === 4 && cropValues.every(Number.isFinite)) {
      const [x, y, width, height] = cropValues;
      source = source.crop({ x, y, width, height });
    }
    const size = source.getSize();
    const upscale = Math.min(4, Math.max(1, 2200 / Math.max(size.width, size.height)));
    stage = 'resize fixture';
    const image = source.resize({
      width: Math.round(size.width * upscale),
      height: Math.round(size.height * upscale),
      quality: 'best',
    });
    const startedAt = Date.now();
    stage = 'recognize fixture';
    const result = await service.recognize(image.toPNG());
    process.stdout.write(`${JSON.stringify({
      confidence: Math.round(result.confidence),
      elapsedMs: Date.now() - startedAt,
      recognized: result.text.split('\n').filter(Boolean),
    }, null, 2)}\n`);
  } finally {
    await service.terminate();
    fs.rmSync(dataDir, { recursive: true, force: true });
    app.quit();
  }
}

main().catch((error) => {
  process.stderr.write(`${stage}: ${error.stack || error.message}\n`);
  process.exitCode = 1;
  app.quit();
});
