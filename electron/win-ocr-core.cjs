const { spawn } = require('node:child_process');
const path = require('node:path');

// Offline OCR through the Windows built-in WinRT engine (win-ocr.ps1).
// One powershell.exe 5.1 process per recognition (pwsh 7 has no WinRT
// projections); jobs are serialized so bursts of pins never spawn a
// process storm. Results are cached upstream by the pin OCR LRU.

const DEFAULT_LANGUAGE = 'zh-Hans';
const DEFAULT_TIMEOUT_MS = 30000;

// Shapes WinRT word boxes into the per-character item contract used by the
// pin text-selection layer (same shape the old Tesseract path produced).
// `scaleX`/`scaleY` map from the OCR bitmap back to the source image when
// the script upscaled/downscaled before decoding.
function flattenWinOcrLines(lines, { scaleX = 1, scaleY = 1 } = {}) {
  const items = [];
  let lineId = 0;
  let wordId = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const words = (Array.isArray(line?.words) ? line.words : [])
      .filter((word) => typeof word?.text === 'string' && word.text.trim())
      .filter((word) => Number(word.w) > 0 && Number(word.h) > 0);
    if (!words.length) continue;
    const lineStart = items.length;
    for (const word of words) {
      const wordStart = items.length;
      const characters = [...word.text.replace(/\s+/g, '')];
      const x = Number(word.x);
      const width = Number(word.w);
      const y = Number(word.y);
      const height = Number(word.h);
      characters.forEach((character, index) => {
        const x0 = x + width * index / characters.length;
        const x1 = x + width * (index + 1) / characters.length;
        items.push({
          text: character,
          prefix: items.length === 0 ? '' : items.length === lineStart ? '\n' : index === 0 ? ' ' : '',
          lineId,
          wordId,
          bbox: {
            x0: x0 * scaleX,
            y0: y * scaleY,
            x1: x1 * scaleX,
            y1: (y + height) * scaleY,
          },
        });
      });
      if (items.length > wordStart) wordId += 1;
    }
    if (items.length > lineStart) lineId += 1;
  }
  return items;
}

function runWinOcrScript(scriptPath, imagePath, language, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-File', scriptPath,
      '-ImagePath', imagePath,
      '-Language', language,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('文字识别超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT'
        ? new Error('系统 PowerShell 不可用，无法进行文字识别')
        : error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const jsonStart = stdout.indexOf('{');
      if (jsonStart < 0) {
        const detail = (stderr || stdout || 'no output').split('\n').filter(Boolean).slice(0, 2).join(' ');
        reject(new Error(`文字识别失败：${detail.slice(0, 160)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.slice(jsonStart)));
      } catch (error) {
        reject(new Error(`文字识别输出无法解析：${error.message}`));
      }
    });
  });
}

function createWinOcrService({
  scriptPath = path.join(__dirname, 'win-ocr.ps1'),
  language = DEFAULT_LANGUAGE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let queue = Promise.resolve();

  function recognize(imagePath, { sourceSize } = {}) {
    const job = queue.catch(() => {}).then(async () => {
      const result = await runWinOcrScript(scriptPath, imagePath, language, timeoutMs);
      const bitmapWidth = Number(result.width) || 0;
      const bitmapHeight = Number(result.height) || 0;
      const scaleX = sourceSize && bitmapWidth ? sourceSize.width / bitmapWidth : 1;
      const scaleY = sourceSize && bitmapHeight ? sourceSize.height / bitmapHeight : 1;
      const items = flattenWinOcrLines(result.lines, { scaleX, scaleY });
      return {
        text: String(result.text || ''),
        confidence: 100,
        items,
        imageSize: sourceSize || { width: bitmapWidth, height: bitmapHeight },
      };
    });
    queue = job;
    return job;
  }

  return { recognize };
}

module.exports = { createWinOcrService, flattenWinOcrLines, DEFAULT_LANGUAGE };
