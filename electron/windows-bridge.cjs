const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

class WindowsBridge {
  constructor(options = {}) {
    this.scriptPath = options.scriptPath || path.join(__dirname, 'windows-bridge.ps1');
    this.timeoutMs = options.timeoutMs || 1500;
    this.executable = options.executable || 'pwsh.exe';
    this.restartBaseDelayMs = options.restartBaseDelayMs || 250;
    this.restartMaxDelayMs = options.restartMaxDelayMs || 8000;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopping = false;
    this.consecutiveFailures = 0;
    this.restartTimer = null;
    this.triedFallbackShell = false;
  }

  start() {
    if (this.child && !this.child.killed) return;
    if (this.stopping) return;
    const child = spawn(this.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-File', this.scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.handleSpawnError(error));
    child.on('exit', () => this.handleExit(new Error('Windows bridge stopped')));
  }

  handleSpawnError(error) {
    this.child = null;
    // pwsh.exe (PowerShell 7) is not preinstalled on Windows; fall back to the
    // inbox powershell.exe 5.1 once before giving up to the restart backoff.
    if (error.code === 'ENOENT' && !this.triedFallbackShell) {
      this.triedFallbackShell = true;
      this.executable = 'powershell.exe';
      this.start();
      return;
    }
    this.scheduleRestart();
  }

  scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = Math.min(this.restartBaseDelayMs * 2 ** this.consecutiveFailures, this.restartMaxDelayMs);
    this.consecutiveFailures += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = this.pending.get(String(message.id));
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(String(message.id));
    this.consecutiveFailures = 0;
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error || 'Windows bridge request failed'));
  }

  handleExit(error) {
    this.child = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.scheduleRestart();
  }

  request(op, payload = {}) {
    this.start();
    if (!this.child?.stdin?.writable) return Promise.reject(new Error('Windows bridge unavailable'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Windows bridge ${op} timed out`));
      }, this.timeoutMs + (Number(payload.delayMs) || 0));
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
    });
  }

  foreground() {
    return this.request('foreground');
  }

  keysDown(groups) {
    return this.request('keysDown', { groups });
  }

  clipboardSequence() {
    return this.request('clipboardSequence');
  }

  readFiles() {
    return this.request('readFiles');
  }

  writeFiles(files) {
    return this.request('writeFiles', { files });
  }

  isAvailable() {
    return Boolean(this.child && !this.child.killed && this.child.stdin?.writable);
  }

  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }

  paste(target, delayMs) {
    return this.request('paste', { target: String(target || '0'), delayMs });
  }

  windowBounds(target) {
    return this.request('windowBounds', { target: String(target || '0') });
  }

  captureDisplay(filePath) {
    return this.request('captureDisplay', { filePath: String(filePath || '') });
  }
}

module.exports = { WindowsBridge };
