import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPaddleOcrService } = require('../electron/paddle-ocr-core.cjs');

const imagePath = process.argv[2];
if (!imagePath || !fs.existsSync(imagePath)) throw new Error('Pass an existing image path');

const startedAt = Date.now();
const ocr = createPaddleOcrService();
const result = await ocr.recognize(path.resolve(imagePath));
process.stdout.write(`${JSON.stringify({
  elapsedMs: Date.now() - startedAt,
  confidence: Math.round(result.confidence),
  selectableCharacterCount: result.items.length,
  recognized: result.text.split('\n'),
}, null, 2)}\n`);
process.exit(0);
