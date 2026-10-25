import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency hygiene check for the portable app:
//   - package.json "dependencies" must stay empty (portable build ships zero
//     runtime npm deps, per AGENTS.md).
//   - every devDependency must be referenced from source code or the
//     "scripts" section.
//   - every imported package must be declared as a devDependency.
//
// Scans: src/, electron/, scripts/, worker/, vite.config.mjs, *.html, and
// the package.json "scripts" command strings. Built-in node: specifiers and
// relative paths are ignored.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const SCAN_DIRS = ['src', 'src-tauri', 'scripts', 'worker'];
const SCAN_ROOT_FILES = ['vite.config.mjs'];
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'release', 'out', 'build', '.git', '.tmp',
]);

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Extracts the npm package name from a specifier, ignoring node: builtins,
// relative paths, and bare URL imports. Handles scoped packages and subpaths.
function packageName(specifier) {
  if (!specifier) return null;
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) return null;
  if (specifier.startsWith('@')) {
    const first = specifier.indexOf('/');
    if (first < 0) return null;
    const second = specifier.indexOf('/', first + 1);
    return second >= 0 ? specifier.slice(0, second) : specifier;
  }
  const slash = specifier.indexOf('/');
  return slash >= 0 ? specifier.slice(0, slash) : specifier;
}

// Matches ESM/CommonJS import specifiers:
//   import ... from 'x'   import 'x'   require('x')   import('x')
// Also catches dynamic import('x') and side-effect ESM imports.
const IMPORT_RE = /(?:import\s+(?:[^'"`;]*?\s+from\s+)?|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
// Matches a <script src="..."> reference inside an HTML file.
const HTML_SRC_RE = /<script\b[^>]*?\bsrc=["']([^"']+)["']/gi;

function recordHit(map, name, file, line, spec) {
  if (!map.has(name)) map.set(name, []);
  map.get(name).push({ file, line, spec });
}

// Strip // line comments, /* block */ comments, and <!-- html --> comments so
// example specifiers in documentation don't trigger false positives.
function stripComments(text) {
  // Block comments first (multiline), then line comments. HTML comments too.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p1) => `${p1}${''.padEnd(m.length - p1.length, ' ')}`);
}

function scanCodeFile(absPath, relPath, imports) {
  const text = stripComments(fs.readFileSync(absPath, 'utf8'));
  IMPORT_RE.lastIndex = 0;
  let match;
  while ((match = IMPORT_RE.exec(text))) {
    const name = packageName(match[1]);
    if (!name) continue;
    const original = fs.readFileSync(absPath, 'utf8');
    const line = original.slice(0, match.index).split(/\r?\n/).length;
    recordHit(imports, name, relPath, line, match[1]);
  }
}

function scanHtmlFile(absPath, relPath, imports) {
  const text = stripComments(fs.readFileSync(absPath, 'utf8'));
  HTML_SRC_RE.lastIndex = 0;
  let match;
  while ((match = HTML_SRC_RE.exec(text))) {
    const spec = match[1];
    if (spec.startsWith('http://') || spec.startsWith('https://')) continue;
    const name = packageName(spec);
    if (!name) continue;
    const original = fs.readFileSync(absPath, 'utf8');
    const line = original.slice(0, match.index).split(/\r?\n/).length;
    recordHit(imports, name, relPath, line, spec);
  }
}

const imports = new Map();

for (const dir of SCAN_DIRS) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    if (!CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    scanCodeFile(file, path.relative(root, file), imports);
  }
}

for (const file of SCAN_ROOT_FILES) {
  const abs = path.join(root, file);
  if (fs.existsSync(abs)) scanCodeFile(abs, file, imports);
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
  scanHtmlFile(path.join(root, entry.name), entry.name, imports);
}

// Check whether a package name appears anywhere inside any "scripts" string.
function referencedInScripts(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^A-Za-z0-9_@/-])${escaped}([^A-Za-z0-9_@/-]|$)`);
  const scripts = pkg.scripts ?? {};
  for (const cmd of Object.values(scripts)) {
    if (re.test(cmd)) return true;
  }
  return false;
}

function isReferenced(dep) {
  return imports.has(dep) || referencedInScripts(dep);
}

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
const devDeps = Object.keys(pkg.devDependencies ?? {});
const declared = new Set([...runtimeDeps, ...devDeps]);

const violations = [];

if (runtimeDeps.length) {
  violations.push(
    `package.json "dependencies" must be empty (portable build ships zero runtime npm deps). Found: ${runtimeDeps.join(', ')}`,
  );
}

for (const dep of devDeps) {
  if (!isReferenced(dep)) {
    violations.push(`devDependency "${dep}" is not referenced in source code or npm scripts`);
  }
}

for (const [name, hits] of imports) {
  if (!declared.has(name)) {
    const locs = hits.map((h) => `      ${h.file}:${h.line}  ${h.spec}`).join('\n');
    violations.push(`package "${name}" is imported but not declared in package.json\n${locs}`);
  }
}

if (violations.length === 0) {
  const counts = `${imports.size} package import(s) across src/electron/scripts/worker, ${devDeps.length} devDep(s) declared`;
  console.log(`check-deps: clean. ${counts}.`);
  process.exit(0);
}

console.error(`check-deps: ${violations.length} violation(s):`);
for (const v of violations) console.error(`  - ${v}`);
process.exit(1);
