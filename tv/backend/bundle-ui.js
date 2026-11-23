#!/usr/bin/env node
'use strict';
// node tv/backend/bundle-ui.js <out-file>
// Mineradio's index-loader.js fetches its ~110 module files one by one and runs them as one script.
// On a TV every one of those fetches is a round trip through the app, so the same text is put
// together here once, at build time; TvRouter serves it in place of the loader. The modules
// themselves are not changed, and neither is their order.
const fs = require('fs');
const path = require('path');
const PUBLIC = path.resolve(__dirname, '../../public');
const out = path.resolve(process.argv[2]);
const loader = fs.readFileSync(path.join(PUBLIC, 'js/index-loader.js'), 'utf8');
const list = /const modulePaths = \[([\s\S]*?)\];/.exec(loader);
if (!list) throw new Error('index-loader.js: module list not found');
const paths = Array.from(list[1].matchAll(/'([^']+\.js)'/g), (m) => m[1]);
if (paths.length < 50) throw new Error('index-loader.js: only ' + paths.length + ' modules found');
const text = paths.map((p) => fs.readFileSync(path.join(PUBLIC, p), 'utf8')).join('') + '\n//# sourceURL=mineradio-index-modules.js\n';
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text);
console.log('[bundle-ui] %d modules, %s MB -> %s', paths.length, (text.length / 1048576).toFixed(1), out);
