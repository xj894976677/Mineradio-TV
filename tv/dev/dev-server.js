#!/usr/bin/env node
'use strict';
// Mineradio-TV dev server: serves the unmodified web UI from ../../public with the TV layer
// injected, and answers the same /tvapi/* contract the Android TV shell implements
// (tv/app/src/main/java/.../TvRouter.kt). For working on tv.js / tv.css in a desktop browser.
//
//   node tv/dev/dev-server.js <music-folder> [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const MUSIC = path.resolve(process.argv[2] || '.');
const PORT = Number(process.argv[3] || 8790);
const PUBLIC = path.resolve(__dirname, '../../public');
const TV_ASSETS = path.resolve(__dirname, '../app/src/main/assets/tv');
const AUDIO_RE = /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

let tracks = [];
function walk(dir, depth) {
  if (depth > 8) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (AUDIO_RE.test(e.name)) tracks.push(describe(full));
  }
}
function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const tags = Object.fromEntries(Object.entries((j.format && j.format.tags) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { title: tags.title, artist: tags.artist, album: tags.album, duration: Number(j.format && j.format.duration) || 0, hasCover: (j.streams || []).some(s => s.codec_type === 'video') };
  } catch (e) { return {}; }
}
function sidecar(file, exts) {
  const base = file.replace(/\.[^.]+$/, '');
  for (const ext of exts) if (fs.existsSync(base + ext)) return base + ext;
  return '';
}
function folderCover(file) {
  const dir = path.dirname(file);
  for (const n of ['cover.jpg', 'cover.png', 'folder.jpg', 'front.jpg', 'Cover.jpg', 'Folder.jpg']) if (fs.existsSync(path.join(dir, n))) return path.join(dir, n);
  return '';
}
function describe(file) {
  const st = fs.statSync(file);
  const meta = probe(file);
  const rel = path.relative(MUSIC, file);
  const lrc = sidecar(file, ['.lrc', '.LRC']);
  const img = sidecar(file, ['.jpg', '.png']) || folderCover(file);
  return {
    id: String(tracks.length),
    name: meta.title || path.basename(file).replace(/\.[^.]+$/, ''),
    artist: meta.artist || '',
    album: meta.album || '',
    folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
    volume: path.basename(MUSIC),
    duration: meta.duration || 0,
    hasCover: !!(meta.hasCover || img),
    hasLyric: !!lrc,
    key: [rel, st.size, Math.round(st.mtimeMs)].join(':'),
    _file: file, _lrc: lrc, _img: img, _embedded: !!meta.hasCover,
  };
}
function scan() { tracks = []; walk(MUSIC, 0); console.log('[tv-dev] %d tracks in %s', tracks.length, MUSIC); }
function publicTrack(t) { const c = Object.assign({}, t); delete c._file; delete c._lrc; delete c._img; delete c._embedded; return c; }

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}
function sendFile(req, res, file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return send(res, 404, 'not found', 'text/plain'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}
function injectTv(html) {
  const head = '<script src="tv/tv-preload.js"></script>';
  const tail = '<link rel="stylesheet" href="tv/tv.css"><script src="tv/tv.js"></script>';
  return html.replace(/<head([^>]*)>/i, '<head$1>' + head).replace(/<\/body>/i, tail + '</body>');
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith('/tvapi/')) {
    const t = tracks[Number(url.searchParams.get('id'))];
    if (p === '/tvapi/library') return send(res, 200, JSON.stringify({ ok: true, access: 'all', scanning: false, volumes: [path.basename(MUSIC)], tracks: tracks.map(publicTrack) }));
    if (p === '/tvapi/rescan') { scan(); return send(res, 200, JSON.stringify({ ok: true })); }
    if (p === '/tvapi/device') return send(res, 200, JSON.stringify({ ok: true, dev: true, model: 'dev-server' }));
    if (!t) return send(res, 404, '{"ok":false}');
    if (p === '/tvapi/audio') return sendFile(req, res, t._file);
    if (p === '/tvapi/lyric') return t._lrc ? send(res, 200, JSON.stringify({ ok: true, lyric: fs.readFileSync(t._lrc, 'utf8') })) : send(res, 200, '{"ok":true,"lyric":""}');
    if (p === '/tvapi/cover') {
      if (t._embedded) {
        return execFile('ffmpeg', ['-v', 'quiet', '-i', t._file, '-an', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { encoding: 'buffer', maxBuffer: 32 << 20 }, (err, out) => {
          if (err || !out.length) return t._img ? sendFile(req, res, t._img) : send(res, 404, '', 'text/plain');
          send(res, 200, out, 'image/jpeg', { 'Cache-Control': 'max-age=3600' });
        });
      }
      return t._img ? sendFile(req, res, t._img) : send(res, 404, '', 'text/plain');
    }
    return send(res, 404, '{"ok":false}');
  }
  if (p.startsWith('/api/')) return send(res, 200, JSON.stringify({ ok: false, code: 503, offline: true, error: 'OFFLINE_TV' }));
  if (p === '/' || p === '/index.html') return send(res, 200, injectTv(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')), MIME['.html']);
  if (p.startsWith('/tv/')) return sendFile(req, res, path.join(TV_ASSETS, path.normalize(p.slice(4)).replace(/^(\.\.[\/\\])+/, '')));
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  sendFile(req, res, file);
}).listen(PORT, '127.0.0.1', () => { scan(); console.log('[tv-dev] http://127.0.0.1:%d', PORT); });
