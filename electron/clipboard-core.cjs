const crypto = require('node:crypto');
const path = require('node:path');

const DEFAULT_PREFERENCES = Object.freeze({
  captureText: true,
  captureImages: true,
  captureFiles: true,
  captureRichText: true,
  trackSource: true,
  mergeDuplicates: true,
  protectSensitive: true,
  showCopyToast: true,
  autoRemoteDelay: true,
  pasteDelay: 35,
  remotePasteDelay: 320,
  historyLimit: 120,
});

const REMOTE_APP_PATTERN = /(?:gameviewer|todesk|awesun|sunlogin|mstsc|rustdesk|anydesk|teamviewer|parsec|向日葵|uu远程)/i;

function hashBuffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function normalizeText(content) {
  return String(content || '').replace(/\0/g, '').replace(/\r\n/g, '\n').trim();
}

function classifyText(content) {
  const trimmed = normalizeText(content);
  if (!trimmed) return 'text';
  try {
    const value = new URL(trimmed);
    if (value.protocol === 'http:' || value.protocol === 'https:') return 'url';
  } catch {}
  const filePath = /^(?:[a-z]:\\|\\\\)[^\r\n]+$/i;
  if (filePath.test(trimmed)) return 'file';
  const codeSignals = /(^|\s)(npm|pnpm|yarn|git|docker|kubectl|adb|select|update|insert|delete|curl|ssh|pip|python|node|cargo|go)\b|[{}();]|=>|^#!\//i;
  return codeSignals.test(trimmed) ? 'code' : 'text';
}

function entryTitle(content, type, files = []) {
  const firstLine = normalizeText(content).split('\n')[0];
  if (type === 'url') {
    try { return new URL(firstLine).hostname.replace(/^www\./, ''); } catch {}
  }
  if (type === 'file') {
    const firstPath = files[0] || firstLine;
    return files.length > 1 ? `${path.basename(firstPath)} 等 ${files.length} 个文件` : path.basename(firstPath);
  }
  return firstLine.slice(0, 80);
}

function detectSensitive(content) {
  const text = normalizeText(content);
  if (!text) return null;
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, '私钥'],
    ['password', /(?:password|passwd|pwd|密码)\s*[:=]\s*[^\s]{4,}/i, '密码'],
    ['token', /(?:api[_-]?key|access[_-]?token|secret|authorization)\s*[:=]\s*["']?[a-z0-9_\-.]{12,}/i, '访问密钥'],
    ['bearer', /\bbearer\s+[a-z0-9_\-.]{16,}/i, 'Bearer Token'],
    ['jwt', /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/, 'JWT'],
  ];
  for (const [kind, pattern, label] of rules) {
    if (pattern.test(text)) return { kind, label };
  }
  const digits = text.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digits) && passesLuhn(digits)) return { kind: 'payment-card', label: '银行卡号' };
  return null;
}

function passesLuhn(value) {
  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function textFingerprint(content, html = '') {
  return `text:${hashBuffer(Buffer.from(`${normalizeText(content)}\n${normalizeText(html)}`))}`;
}

function fileFingerprint(files) {
  return `file:${hashBuffer(Buffer.from([...files].map((item) => item.toLocaleLowerCase()).sort().join('\n')))}`;
}

function mergePreferences(value) {
  const input = value && typeof value === 'object' ? value : {};
  const historyLimit = Math.min(1000, Math.max(20, Number(input.historyLimit) || DEFAULT_PREFERENCES.historyLimit));
  const pasteDelay = Math.min(300, Math.max(0, Number(input.pasteDelay) || DEFAULT_PREFERENCES.pasteDelay));
  const remotePasteDelay = Math.min(1200, Math.max(100, Number(input.remotePasteDelay) || DEFAULT_PREFERENCES.remotePasteDelay));
  return { ...DEFAULT_PREFERENCES, ...input, historyLimit, pasteDelay, remotePasteDelay };
}

function isRemoteSource(source) {
  return REMOTE_APP_PATTERN.test(`${source?.app || ''} ${source?.title || ''}`);
}

function resolvePasteDelay(preferences, source) {
  const value = mergePreferences(preferences);
  return value.autoRemoteDelay && isRemoteSource(source) ? value.remotePasteDelay : value.pasteDelay;
}

function isScreenshotEntry(entry) {
  return entry?.type === 'image' && entry?.origin === 'screenshot';
}

function removePinnedScreenshot(items, id) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.id !== id);
}

function defaultCaptureRegion(displayBounds, cursor, preferredWidth = 520, preferredHeight = 320) {
  const width = Math.min(displayBounds.width, Math.max(160, preferredWidth));
  const height = Math.min(displayBounds.height, Math.max(120, preferredHeight));
  const x = Math.min(
    displayBounds.x + displayBounds.width - width,
    Math.max(displayBounds.x, Math.round(cursor.x - width / 2)),
  );
  const y = Math.min(
    displayBounds.y + displayBounds.height - height,
    Math.max(displayBounds.y, Math.round(cursor.y - height / 2)),
  );
  return { x, y, width, height };
}

function capturePinBounds(displayBounds, imageSize, crop) {
  if (!displayBounds || !imageSize || !crop || imageSize.width <= 0 || imageSize.height <= 0) return null;
  const scaleX = displayBounds.width / imageSize.width;
  const scaleY = displayBounds.height / imageSize.height;
  return {
    x: Math.round(displayBounds.x + crop.x * scaleX),
    y: Math.round(displayBounds.y + crop.y * scaleY),
    width: Math.max(1, Math.round(crop.width * scaleX)),
    height: Math.max(1, Math.round(crop.height * scaleY)),
  };
}

function zoomPinBounds(bounds, pointer, deltaY, aspectRatio = bounds?.width / bounds?.height) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(deltaY) || deltaY === 0) return bounds;
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : bounds.width / bounds.height;
  const steps = Math.min(4, Math.max(0.25, Math.abs(deltaY) / 100));
  const requestedScale = 1.12 ** (deltaY < 0 ? steps : -steps);
  const minimumScale = Math.max(80 / bounds.width, 60 / bounds.height);
  const maximumScale = Math.min(4096 / bounds.width, 4096 / bounds.height);
  const scale = Math.min(maximumScale, Math.max(minimumScale, requestedScale));
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(width / ratio));
  const pointerX = Math.min(bounds.width, Math.max(0, Number(pointer?.x) || 0));
  const pointerY = Math.min(bounds.height, Math.max(0, Number(pointer?.y) || 0));
  const anchorX = bounds.x + pointerX;
  const anchorY = bounds.y + pointerY;
  return {
    x: Math.round(anchorX - (pointerX / bounds.width) * width),
    y: Math.round(anchorY - (pointerY / bounds.height) * height),
    width,
    height,
  };
}

function resetPinBounds(bounds, baseArea, aspectRatio = bounds?.width / bounds?.height) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return bounds;
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : bounds.width / bounds.height;
  const area = Number.isFinite(baseArea) && baseArea > 0 ? baseArea : bounds.width * bounds.height;
  const width = Math.max(1, Math.round(Math.sqrt(area * ratio)));
  const height = Math.max(1, Math.round(width / ratio));
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
    width,
    height,
  };
}

function migrateEntry(entry) {
  const createdAt = Number(entry.createdAt) || Date.now();
  return {
    ...entry,
    createdAt,
    lastCopiedAt: Number(entry.lastCopiedAt) || createdAt,
    copyCount: Math.max(1, Number(entry.copyCount) || 1),
    formats: Array.isArray(entry.formats) ? entry.formats : [entry.type === 'image' ? 'image/png' : 'text/plain'],
    source: entry.source && typeof entry.source === 'object' ? entry.source : null,
  };
}

module.exports = {
  DEFAULT_PREFERENCES,
  classifyText,
  detectSensitive,
  capturePinBounds,
  defaultCaptureRegion,
  entryTitle,
  fileFingerprint,
  hashBuffer,
  mergePreferences,
  migrateEntry,
  normalizeText,
  isRemoteSource,
  isScreenshotEntry,
  removePinnedScreenshot,
  resetPinBounds,
  resolvePasteDelay,
  textFingerprint,
  zoomPinBounds,
};
