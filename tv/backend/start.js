'use strict';
// Starts Mineradio's own back end (../../server.js, unmodified) for the TV app.
//
// The Qishui modules are left out: they need Electron, and they include a decryptor for protected
// audio that the TV edition does not ship. Anything server.js asks of them answers "not
// available", so the NetEase, QQ and Kugou routes work and the Qishui ones fail cleanly.
const Module = require('module');
const path = require('path');

const ROOT = process.env.MINERADIO_ROOT || path.resolve(__dirname, '../..');
// music-metadata: only NetEase's cloud-upload module asks for it, and Node 18 (nodejs-mobile)
// cannot require() an ES-module-only package; the TV app uploads nothing.
const LEFT_OUT = new Set(['electron', 'qishui-api', 'qishui-qr-login', 'qishui-auth-v6', 'track-decryptor', 'music-metadata']);

function unavailable(name) {
  const fail = function () { return Promise.reject(Object.assign(new Error('QISHUI_NOT_IN_TV'), { code: 'QISHUI_NOT_IN_TV' })); };
  // server.js builds one at start; the instance answers like the module does.
  function Missing() { return unavailable(name); }
  return new Proxy({}, {
    get(_, key) {
      if (key === '__esModule') return false;
      if (typeof key === 'symbol') return undefined;
      if (/^[A-Z]/.test(String(key))) return Missing;       // classes: TrackDecryptor
      return fail;                                            // everything else is a function
    },
  });
}

const load = Module._load;
Module._load = function (request, parent, isMain) {
  const base = path.basename(String(request)).replace(/\.js$/, '');
  if (LEFT_OUT.has(base)) return unavailable(base);
  return load.apply(this, arguments);
};

// On the TV there is no terminal: keep the last of the log in a file the app can show.
if (process.env.MRTV_LOG_FILE) {
  const fs = require('fs');
  try { fs.writeFileSync(process.env.MRTV_LOG_FILE, ''); } catch (e) { }
  let written = 0;
  const write = (level, args) => {
    if (written > 512 * 1024) return;
    try {
      const line = new Date().toISOString() + ' ' + level + ' ' + args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
      written += line.length;
      fs.appendFileSync(process.env.MRTV_LOG_FILE, line);
    } catch (e) { }
  };
  ['log', 'info', 'warn', 'error'].forEach((level) => { console[level] = (...args) => write(level, args); });
  process.on('uncaughtException', (e) => { write('fatal', [e]); });
}

process.on('unhandledRejection', (e) => { if (!(e && e.code === 'QISHUI_NOT_IN_TV')) console.warn('[mrtv-backend] unhandled', e && e.message); });
require(path.join(ROOT, 'server.js'));
