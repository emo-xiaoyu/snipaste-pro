const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

class WindowsBridge {
  constructor(options = {}) {
    this.scriptPath = options.scriptPath || path.join(__dirname, 'windows-bridge.ps1');
    this.timeoutMs = options.timeoutMs || 1500;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopping = false;
  }

  start() {
    if (this.child && !this.child.killed) return;
    this.stopping = false;
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.scriptPath], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', () => this.handleExit(new Error('Windows bridge stopped')));
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = this.pending.get(String(message.id));
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(String(message.id));
    if (message.ok) request.resolve(message.data);
    else request.reject(new Error(message.error || 'Windows bridge request failed'));
  }

  handleExit(error) {
    const wasStopping = this.stopping;
    this.child = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!wasStopping) setTimeout(() => this.start(), 250);
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

  foregroundWithBounds() {
    return this.request('foregroundWithBounds');
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

  stop() {
    this.stopping = true;
    this.child?.stdin?.end();
    this.child?.kill();
    this.child = null;
  }
}

module.exports = { WindowsBridge };
