#!/usr/bin/env node
'use strict';
// Stages Mineradio's back end for the TV app: node tv/backend/pack.js <out-dir>
//
// Copies server.js, the provider modules it loads, tv/backend/start.js and, from node_modules, only
// the packages the back end can reach: the dependency closure of ROOTS, read from each package's
// own package.json. What the TV edition stubs (start.js) or never loads (gsap is the web UI's,
// music-metadata is ESM-only) stays out, and so do files no require() asks for.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.resolve(process.argv[2] || 'backend-stage');
const ROOTS = ['NeteaseCloudMusicApi', 'qrcode', 'mpg123-decoder'];
const SKIP_PACKAGES = new Set(['music-metadata', 'gsap', 'electron']);
const FILES = ['server.js', 'package.json', 'dj-analyzer.js', 'kugou-api.js', 'qq-vip-api.js', 'spotify-api.js', 'LICENSE', 'NOTICE.md', 'tv/backend/start.js'];
const DIRS = ['cuefield'];
const SKIP_FILE = /(\.md|\.markdown|\.map|\.ts|\.tsx|\.flow|\.coffee|\.yml|\.yaml|\.editorconfig|\.eslintrc.*|\.prettierrc.*|\.npmignore|\.gitattributes|tsconfig.*\.json|CHANGELOG.*|HISTORY.*|AUTHORS.*|Makefile|\.travis.*)$/i;
// Whole paths no require() reaches: the API package's demo site, a browser build.
const SKIP_PATH = [/node_modules\/NeteaseCloudMusicApi\/public$/, /node_modules\/xml2js\/lib\/xml2js\.bc\.js$/, /node_modules\/axios\/dist\/(browser|esm)$/, /node_modules\/node-forge\/dist$/, /node_modules\/crypto-js\/crypto-js\.js$/];
const SKIP_DIR = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github', 'benchmark', 'benchmarks', 'coverage', '.bin']);

function findPackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === ROOT || dir === path.dirname(dir)) return null;
  }
}
const wanted = new Set();
function closure(name, fromDir) {
  if (SKIP_PACKAGES.has(name)) return;
  const dir = findPackage(name, fromDir);
  if (!dir || wanted.has(dir)) return;
  wanted.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(Object.assign({}, pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies))) closure(dep, dir);
}
ROOTS.forEach((name) => closure(name, ROOT));

let files = 0, bytes = 0;
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  files++; bytes += fs.statSync(src).size;
}
function copyDir(src, dst, isPackageRoot) {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    if (SKIP_PATH.some((re) => re.test(from.split(path.sep).join('/')))) continue;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;          // nested packages are copied if wanted
      if (SKIP_DIR.has(entry.name.toLowerCase())) continue;
      copyDir(from, path.join(dst, entry.name), false);
    } else if (entry.isFile()) {
      if (SKIP_FILE.test(entry.name) && entry.name !== 'package.json') continue;
      copyFile(from, path.join(dst, entry.name));
    }
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
for (const f of FILES) copyFile(path.join(ROOT, f), path.join(OUT, f));
for (const d of DIRS) copyDir(path.join(ROOT, d), path.join(OUT, d), false);
for (const dir of wanted) copyDir(dir, path.join(OUT, path.relative(ROOT, dir)), true);
console.log('[pack] %d packages, %d files, %s MB -> %s', wanted.size, files, (bytes / 1048576).toFixed(1), OUT);
