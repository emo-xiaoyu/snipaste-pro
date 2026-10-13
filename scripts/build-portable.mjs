import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Assembles the portable, no-installer distribution:
//   release/portable/Pasty/            <- unzip anywhere and run Pasty.exe
//   release/Pasty-Portable-<version>.zip
// Layout: the stock Electron runtime plus resources/app holding the main
// process (electron/), the bundled renderer (dist/client), and package.json.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRuntime = path.join(root, 'node_modules', 'electron', 'dist');
const stagingRoot = path.join(root, 'release', 'portable');
const appDir = path.join(stagingRoot, 'Pasty');

function copyDir(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true });
}

function dirSizeMegabytes(target) {
  let total = 0;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const itemPath = path.join(item.parentPath ?? dir, item.name);
      if (item.isDirectory()) walk(itemPath);
      else total += fs.statSync(itemPath).size;
    }
  };
  walk(target);
  return total / 1024 / 1024;
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const missing = ['dist/client/index.html', 'electron/main.cjs'].filter(
  (relative) => !fs.existsSync(path.join(root, relative)),
);
if (missing.length) {
  console.error(`Portable build is missing: ${missing.join(', ')}. Run "vite build" first.`);
  process.exit(1);
}

fs.rmSync(stagingRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(appDir, 'resources', 'app'), { recursive: true });

copyDir(electronRuntime, appDir);
// Windows occasionally holds a transient lock on the fresh copy (indexer,
// Defender); retry once before giving up.
for (let attempt = 1; ; attempt += 1) {
  try {
    fs.renameSync(path.join(appDir, 'electron.exe'), path.join(appDir, 'Pasty.exe'));
    break;
  } catch (error) {
    if (attempt >= 3) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

// Slim the runtime: keep only the locales we ship UI for, and drop the
// WebGPU shader compiler (dxcompiler/dxil) — the app renders with Canvas 2D
// and ANGLE's d3dcompiler_47.dll, which stays.
const keptLocales = new Set(['zh-cn.pak', 'en-us.pak']);
for (const entry of fs.readdirSync(path.join(appDir, 'locales'))) {
  if (!keptLocales.has(entry.toLowerCase())) fs.rmSync(path.join(appDir, 'locales', entry));
}
for (const entry of ['dxcompiler.dll', 'dxil.dll']) {
  fs.rmSync(path.join(appDir, entry), { force: true });
}

copyDir(path.join(root, 'electron'), path.join(appDir, 'resources', 'app', 'electron'));
copyDir(path.join(root, 'dist', 'client'), path.join(appDir, 'resources', 'app', 'dist', 'client'));
fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'resources', 'app', 'package.json'));

const zipPath = path.join(root, 'release', `Pasty-Portable-${pkg.version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path "${appDir}" -DestinationPath "${zipPath}" -Force`,
]);

console.log(`Portable app: ${appDir} (${dirSizeMegabytes(appDir).toFixed(1)} MB)`);
console.log(`Portable zip: ${zipPath} ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
