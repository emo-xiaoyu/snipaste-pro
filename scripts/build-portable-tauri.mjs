import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Assembles the Tauri (Rust) portable distribution:
//   release/portable-tauri/Pasty/Pasty.exe   <- single self-contained binary
//   release/Pasty-Tauri-Portable-<version>.zip
// The frontend is embedded into the exe by Tauri at compile time, so the
// portable layout is just the renamed release binary.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, 'release', 'portable-tauri', 'Pasty');
const exeSource = path.join(root, 'src-tauri', 'target', 'release', 'pasty.exe');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

if (!fs.existsSync(exeSource)) {
  console.error(`Release binary missing: ${exeSource}. Run "cargo build --release" in src-tauri first.`);
  process.exit(1);
}

fs.rmSync(path.join(root, 'release', 'portable-tauri'), { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

// Windows occasionally holds a transient lock on fresh copies (indexer,
// Defender); retry once before giving up.
for (let attempt = 1; ; attempt += 1) {
  try {
    fs.copyFileSync(exeSource, path.join(staging, 'Pasty.exe'));
    break;
  } catch (error) {
    if (attempt >= 3) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

const zipPath = path.join(root, 'release', `Pasty-Tauri-Portable-${pkg.version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path "${staging}" -DestinationPath "${zipPath}" -Force`,
]);

const size = (target) => (fs.statSync(target).size / 1048576).toFixed(2);
console.log(`Portable exe: ${path.join(staging, 'Pasty.exe')} (${size(path.join(staging, 'Pasty.exe'))} MB)`);
console.log(`Portable zip: ${zipPath} (${size(zipPath)} MB)`);
