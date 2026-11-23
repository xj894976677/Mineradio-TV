'use strict';
// Mineradio-TV: the remote-control layer over Mineradio's stage.
//
// The Mineradio modules load unmodified (public/). This file runs after them, in the same global
// scope, and:
//   - reads the offline library from the TV shell (/tvapi/library: USB drives and local storage),
//     puts it in Mineradio's queue as "local" songs and starts playing, resuming where it stopped;
//   - answers the D-pad: OK play/pause, left/right previous/next (hold to seek), up the library,
//     down the settings, back closes a panel and, pressed twice on the stage, leaves;
//   - replaces the dialogs a TV cannot answer (beat-analysis choice, login guide) with their default.
// The same /tvapi contract is served by tv/dev/dev-server.js for work in a desktop browser.
(function () {
  if (window.MRTV) return;
  var TV = window.MRTV = { version: '0.3.0' };
  var native = window.MineradioTVNative || null;
  var LAST_KEY = 'mrtv-last-v1';
  var PREF_KEY = 'mrtv-prefs-v1';
  var ROWS = 8;

  var tracks = [];          // as /tvapi/library gives them
  var songs = [];           // Mineradio song objects, same order
  var groups = [];          // [{ title, note, indexes: [song index] }]
  var libraryInfo = { access: 'none', scanning: false, volumes: [] };
  var mode = 'stage';       // stage | library | settings | empty
  var lib = { col: 1, group: 0, groupTop: 0, track: 0, trackTop: 0 };
  var settingsIdx = 0;
  var started = false;
  var lastTrackKey = '';
  var lastBackAt = 0;
  var hudTimer = 0;
  var toastTimer = 0;
  var prefs = readJson(PREF_KEY) || { beat: true };

  function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { } }
  function api(path) { return fetch(path, { cache: 'no-store' }).then(function (r) { return r.json(); }); }
  function has(name) { return typeof window[name] === 'function'; }
  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (html != null) node.innerHTML = html;
    return node;
  }
  function esc(text) { return String(text == null ? '' : text).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }
  function coverUrl(track) { return track && track.hasCover ? location.origin + '/tvapi/cover?id=' + encodeURIComponent(track.id) : ''; }

  // ---- DOM -------------------------------------------------------------------------------
  var root = el('div', { id: 'mrtv-root' });
  root.innerHTML =
    '<div id="mrtv-hud"><div id="mrtv-hud-cover"></div><div id="mrtv-hud-text">' +
    '<div id="mrtv-hud-title"></div><div id="mrtv-hud-sub"></div>' +
    '<div id="mrtv-hud-bar"><div id="mrtv-hud-fill"></div></div>' +
    '<div id="mrtv-hud-meta"><span id="mrtv-hud-time"></span><span id="mrtv-hud-pos"></span><span id="mrtv-hud-state"></span></div>' +
    '</div></div>' +
    '<div id="mrtv-keys">' +
    '<b>◀ ▶</b><span>上一首 / 下一首</span><b>▲ ▼</b><span>切换视觉</span>' +
    '<b>OK</b><span>播放 / 暂停</span><b>菜单</b><span>设置</span>' +
    '<b>长按 ◀ ▶</b><span>快退 / 快进</span><b>长按 OK</b><span>曲库</span>' +
    '</div>' +
    '<div id="mrtv-toast"></div>' +
    '<div id="mrtv-empty"><h1 id="mrtv-empty-title"></h1><p id="mrtv-empty-line1"></p><p id="mrtv-empty-line2"></p><div class="mrtv-btn" id="mrtv-empty-btn"></div></div>' +
    '<div class="mrtv-panel" id="mrtv-library"><h2>曲库<small id="mrtv-lib-note"></small></h2>' +
    '<div id="mrtv-lib-body"><div class="mrtv-col" id="mrtv-groups"></div><div class="mrtv-col" id="mrtv-tracks"></div></div>' +
    '<div class="mrtv-foot">▲▼ 选择　◀▶ 切换分类和歌曲　OK 播放　菜单 设置　返回 上一级</div></div>' +
    '<div class="mrtv-panel" id="mrtv-login"><h2>登录网易云音乐</h2><div id="mrtv-login-body"><img id="mrtv-login-qr" alt="">' +
    '<div id="mrtv-login-text"><div id="mrtv-login-status"></div><p>登录信息只保存在这台电视上。</p><p>OK 换一个二维码　返回 取消</p></div></div></div>' +
    '<div class="mrtv-panel" id="mrtv-settings"><h2>设置</h2><div id="mrtv-settings-list"></div>' +
    '<div class="mrtv-foot">▲▼ 选择　◀▶ 更改选项　OK 确定　返回 上一级</div></div>';
  document.body.appendChild(root);
  function $(id) { return document.getElementById(id); }

  // Opening title: stays until the first song is on stage (or the empty state is up), 2.6 s at least.
  var titleShownAt = Date.now();
  (function buildTitle() {
    var node = el('div', { id: 'mrtv-title' });
    var word = el('div', { id: 'mrtv-title-word' });
    'Mineradio'.split('').forEach(function (ch, i) {
      var span = el('span'); span.textContent = ch; span.style.animationDelay = (i * 0.09) + 's'; word.appendChild(span);
    });
    'TV'.split('').forEach(function (ch, i) {
      var span = el('span', { 'class': i === 0 ? 'tv' : '' }); span.textContent = ch; span.style.animationDelay = ((9 + i) * 0.09 + 0.15) + 's';
      if (i > 0) span.style.backgroundImage = 'linear-gradient(110deg, #7fe3b0 0%, #7fe3b0 40%, #ffffff 50%, #b9a4ff 60%, #b9a4ff 100%)', span.style.fontWeight = '300';
      word.appendChild(span);
    });
    node.appendChild(word);
    node.appendChild(el('div', { id: 'mrtv-title-sub' }, 'PRIVATE VISUAL RADIO'));
    root.appendChild(node);
    setTimeout(function () { word.classList.add('shine'); }, 1900);
  })();
  function dismissTitle() {
    var node = $('mrtv-title');
    if (!node || node.dataset.leaving) return;
    node.dataset.leaving = '1';
    setTimeout(function () {
      node.classList.add('leave');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1000);
    }, Math.max(0, 2600 - (Date.now() - titleShownAt)));
  }

  function toast(text, ms) {
    var node = $('mrtv-toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('show'); }, ms || 2200);
  }

  // ---- Library ---------------------------------------------------------------------------
  function toSong(track) {
    return {
      type: 'local', source: 'local', provider: 'local',
      name: track.name || '未命名',
      artist: track.artist || '未知艺人',
      album: track.album || track.folder || '',
      localKey: track.key,
      localUrl: location.origin + '/tvapi/audio?id=' + encodeURIComponent(track.id),
      localPath: track.key,
      duration: Number(track.duration) || 0,
      cover: coverUrl(track),
      hasLyric: !!track.hasLyric,
      mrtvId: track.id
    };
  }
  // Online: NetEase through Mineradio's own back end, which runs on the TV (see Backend.kt).
  var NETEASE_CHARTS = [['热歌榜', 3778678], ['新歌榜', 3779629], ['飙升榜', 19723756], ['原创榜', 2884035]];
  var online = { state: 'starting', user: null, playlists: [], recommended: [], daily: null, qq: null, qqPlaylists: [], groups: [] };
  function songKey(song) { return song ? (song.localKey || ((song.provider || song.source || '') + ':' + (song.id || song.mid || song.name))) : ''; }
  function thumbUrl(song, size) {
    var url = song && song.cover ? String(song.cover) : '';
    if (!url) return '';
    if (/music\.126\.net/.test(url)) return url.replace(/^http:/, 'https:') + (url.indexOf('?') < 0 ? '?param=' + size + 'y' + size : '');
    return url;
  }
  function onlineSong(raw) {
    var song = Object.assign({}, raw);
    song.mrtvSeconds = (Number(raw.duration) || 0) / 1000;
    return song;
  }
  function buildOnlineGroups() {
    var out = [];
    if (online.state !== 'ready') { online.groups = out; return; }
    if (online.user) {
      out.push({ title: '每日推荐', note: '网易云', online: { kind: 'daily' }, items: online.daily });
      (online.playlists || []).forEach(function (pl) {
        out.push({ title: pl.name || '歌单', note: '网易云歌单' + (pl.trackCount ? ' · ' + pl.trackCount : ''), online: { kind: 'playlist', id: pl.id }, items: null });
      });
      (online.recommended || []).forEach(function (pl) {
        out.push({ title: pl.name || '歌单', note: '网易云推荐', online: { kind: 'playlist', id: pl.id }, items: null });
      });
    } else {
      out.push({ title: '登录网易云音乐', note: '扫码', login: true, items: [] });
    }
    if (online.qq) {
      (online.qqPlaylists || []).forEach(function (pl) {
        out.push({ title: pl.name || '歌单', note: 'QQ 音乐歌单' + (pl.trackCount ? ' · ' + pl.trackCount : ''), online: { kind: 'qqplaylist', id: pl.id || pl.disstid || pl.tid }, items: null });
      });
      if (!(online.qqPlaylists || []).length) out.push({ title: 'QQ 音乐：没有歌单', note: '', items: [] });
    } else {
      out.push({ title: '登录 QQ 音乐', note: '扫码', qqLogin: true, items: [] });
    }
    NETEASE_CHARTS.forEach(function (c) { out.push({ title: c[0], note: '网易云榜单', online: { kind: 'playlist', id: c[1] }, items: null }); });
    // Keep what was already loaded when the list is rebuilt.
    out.forEach(function (g) {
      if (!g.online || g.items) return;
      var old = online.groups.filter(function (o) { return o.online && o.online.kind === g.online.kind && String(o.online.id) === String(g.online.id) && o.items && o.items.length; })[0];
      if (old) g.items = old.items;
    });
    online.groups = out;
  }
  function groupItems(g) {
    if (!g) return [];
    if (g.items) return g.items;
    if (g.indexes) return g.indexes.map(function (i) { return songs[i]; });
    return [];
  }
  function loadOnlineGroup(g) {
    if (!g || !g.online || g.items || g.loading) return;
    g.loading = true;
    var url = g.online.kind === 'daily' ? '/api/discover/home'
      : (g.online.kind === 'qqplaylist' ? '/api/qq/playlist/tracks?id=' : '/api/playlist/tracks?id=') + encodeURIComponent(g.online.id) + '&limit=300';
    api(url).then(function (r) {
      var list = g.online.kind === 'daily' ? (r && r.dailySongs) : (r && (r.tracks || r.songs));
      g.items = (Array.isArray(list) ? list : []).map(onlineSong);
      g.failed = !g.items.length;
    }).catch(function () { g.items = []; g.failed = true; }).then(function () {
      g.loading = false;
      if (g.failed) g.items = null;
      if (mode === 'library') renderLibrary();
    });
  }
  function refreshOnline() {
    var netease = api('/api/login/status?t=' + Date.now()).then(function (st) {
      online.user = st && st.loggedIn ? st : null;
      if (!online.user) { online.playlists = []; online.recommended = []; online.daily = null; return null; }
      return Promise.all([
        api('/api/user/playlists').then(function (r) { online.playlists = (r && r.playlists) || []; }).catch(function () { }),
        api('/api/discover/home').then(function (r) {
          online.recommendedRaw = (r && r.playlists) || [];
          online.daily = (r && Array.isArray(r.dailySongs) && r.dailySongs.length) ? r.dailySongs.map(onlineSong) : null;
        }).catch(function () { })
      ]).then(function () {
        var mine = {};
        (online.playlists || []).forEach(function (pl) { mine[String(pl.id)] = true; });
        online.recommended = (online.recommendedRaw || []).filter(function (pl) { return pl && pl.id && !mine[String(pl.id)]; });
      });
    }).catch(function () { });
    var qq = api('/api/qq/login/status?t=' + Date.now()).then(function (st) {
      online.qq = st && st.loggedIn ? st : null;
      if (!online.qq) { online.qqPlaylists = []; return null; }
      return api('/api/qq/user/playlists').then(function (r) { online.qqPlaylists = (r && r.playlists) || []; }).catch(function () { });
    }).catch(function () { });
    return Promise.all([netease, qq]).then(function () {
      buildOnlineGroups();
      buildGroups();
      if (mode === 'library') renderLibrary();
      if (mode === 'empty') showEmpty();
    });
  }
  /** Mineradio brings back the last online song by itself, paused: a TV goes on playing it. */
  function resumeOnlineSnapshot() {
    var song = currentSong();
    if (started || !song || song.localKey) return;
    if (typeof audio !== 'undefined' && audio && !audio.paused) return;
    started = true;
    hideEmpty();
    dismissTitle();
    try { if (has('setImmersiveMode')) setImmersiveMode(true); } catch (e) { }
    Promise.resolve(playQueueAt(currentIdx, { manual: false, startupAutoplay: true })).catch(function () { started = false; });
  }
  function watchBackend() {
    api('/tvapi/backend').then(function (r) {
      var state = (r && r.state) || 'failed';
      if (state === online.state) return;
      online.state = state;
      if (state === 'ready') {
        refreshOnline();
        try { if (has('refreshLoginStatus')) refreshLoginStatus(true); } catch (e) { }
        resumeOnlineSnapshot();
      }
      else { buildOnlineGroups(); buildGroups(); }
    }).catch(function () { }).then(function () {
      if (online.state !== 'ready' && online.state !== 'failed') setTimeout(watchBackend, 1500);
    });
  }

  function buildGroups() {
    var all = songs.map(function (_, i) { return i; });
    var out = [];
    if (songs.length) out.push({ title: '全部歌曲', note: '本地', indexes: all });
    online.groups.forEach(function (g) { out.push(g); });
    var byFolder = {}, folderOrder = [];
    var byAlbum = {}, albumOrder = [];
    var byArtist = {}, artistOrder = [];
    tracks.forEach(function (t, i) {
      var folder = (t.volume ? t.volume + (t.folder ? ' / ' : '') : '') + (t.folder || '') || '根目录';
      if (!byFolder[folder]) { byFolder[folder] = []; folderOrder.push(folder); }
      byFolder[folder].push(i);
      if (t.album) { if (!byAlbum[t.album]) { byAlbum[t.album] = []; albumOrder.push(t.album); } byAlbum[t.album].push(i); }
      if (t.artist) { if (!byArtist[t.artist]) { byArtist[t.artist] = []; artistOrder.push(t.artist); } byArtist[t.artist].push(i); }
    });
    var cmp = function (a, b) { return a.localeCompare(b, 'zh-CN', { numeric: true }); };
    folderOrder.forEach(function (name) { out.push({ title: name, note: '文件夹', indexes: byFolder[name] }); });
    albumOrder.sort(cmp).forEach(function (name) { out.push({ title: name, note: '专辑', indexes: byAlbum[name] }); });
    artistOrder.sort(cmp).forEach(function (name) { out.push({ title: name, note: '艺人', indexes: byArtist[name] }); });
    out.push({ title: '设置…', note: '', indexes: [], settings: true });
    groups = out;
    lib.group = Math.max(0, Math.min(lib.group, groups.length - 1));
  }
  function setLibrary(payload) {
    libraryInfo = { access: payload.access || 'none', scanning: !!payload.scanning, volumes: payload.volumes || [] };
    var next = Array.isArray(payload.tracks) ? payload.tracks : [];
    var same = next.length === tracks.length && next.every(function (t, i) { return tracks[i].key === t.key && tracks[i].name === t.name && tracks[i].hasCover === t.hasCover; });
    if (same) return false;
    tracks = next;
    songs = tracks.map(toSong);
    buildGroups();
    lib.track = 0; lib.trackTop = 0;
    return true;
  }
  function loadLibrary(reason) {
    return api('/tvapi/library').then(function (payload) {
      var changed = setLibrary(payload || {});
      if (!songs.length) { showEmpty(); if (!libraryInfo.scanning) dismissTitle(); return; }
      hideEmpty();
      dismissTitle();
      if (!started && !currentSong()) { started = true; startPlayback(); }
      else if (changed && mode === 'library') renderLibrary();
      if (changed && reason === 'mount') toast('已发现 ' + songs.length + ' 首歌曲');
    }).catch(function () { if (!songs.length) { showEmpty(); dismissTitle(); } });
  }
  TV.onLibraryChanged = function () { loadLibrary('mount'); };

  function showEmpty() {
    var noAccess = libraryInfo.access === 'none';
    $('mrtv-empty-title').textContent = libraryInfo.scanning ? '正在扫描音乐…' : (noAccess ? '需要读取存储的权限' : '没有找到音乐');
    $('mrtv-empty-line1').textContent = noAccess ? '允许 Mineradio TV 读取 U 盘和本机里的音乐文件。' : '把存有音乐的 U 盘或移动硬盘插到电视上，会自动开始播放。';
    $('mrtv-empty-line2').textContent = noAccess ? '' : '支持 MP3、FLAC、M4A、WAV、OGG；同名的 .lrc 是歌词，文件夹里的 cover.jpg 是封面。';
    $('mrtv-empty-btn').textContent = noAccess ? '按 OK 去授权' : '按 OK 重新扫描';
    if (online.state === 'ready' && !noAccess) {
      $('mrtv-empty-line2').textContent = '也可以听在线音乐：网易云的榜单，登录后还有每日推荐和你的歌单。';
      $('mrtv-empty-btn').textContent = '按 OK 打开在线音乐';
    }
    if (currentSong()) { hideEmpty(); return; }
    $('mrtv-empty').classList.add('show');
    if (mode === 'stage') mode = 'empty';
  }
  function hideEmpty() {
    $('mrtv-empty').classList.remove('show');
    if (mode === 'empty') mode = 'stage';
  }

  // ---- Playback --------------------------------------------------------------------------
  function currentSong() { return (typeof playQueue !== 'undefined' && playQueue && currentIdx >= 0) ? playQueue[currentIdx] : null; }
  function currentTrack() {
    var song = currentSong();
    if (!song) return null;
    for (var i = 0; i < tracks.length; i++) if (tracks[i].key === song.localKey) return tracks[i];
    return null;
  }
  function playList(indexes, at, resumeAt) { playSongs(indexes.map(function (i) { return songs[i]; }), at, resumeAt); }
  function playSongs(items, at, resumeAt) {
    var list = items.filter(Boolean).map(function (song) { return Object.assign({}, song); });
    if (!list.length) return;
    hideEmpty();
    try {
      homeForcedOpen = false; homeSuppressed = false;
      if (has('setHomeControlsLocked')) setHomeControlsLocked(false);
      playQueue = list;
      currentIdx = Math.max(0, Math.min(list.length - 1, at || 0));
      currentLocalSong = null;
      activeRadioContext = null;
      if (has('safeRenderQueuePanel')) safeRenderQueuePanel('local-import', {});
      if (has('updateEmptyHomeVisibility')) updateEmptyHomeVisibility({ forceLoad: false });
      var opts = { manual: true };
      Promise.resolve(playQueueAt(currentIdx, opts)).then(function () {
        if (resumeAt > 3 && typeof audio !== 'undefined' && audio) {
          var seek = function () { try { if (isFinite(audio.duration) && resumeAt < audio.duration - 5) audio.currentTime = resumeAt; } catch (e) { } };
          if (audio.readyState >= 1) seek(); else audio.addEventListener('loadedmetadata', seek, { once: true });
        }
      }).catch(function (e) { console.warn('[MRTV] play failed', e); });
    } catch (e) { console.warn('[MRTV] playList', e); }
  }
  function startPlayback() {
    var last = readJson(LAST_KEY);
    var all = songs.map(function (_, i) { return i; });
    if (!all.length) return;
    var at = 0, resumeAt = 0;
    if (last && last.key) {
      for (var i = 0; i < tracks.length; i++) if (tracks[i].key === last.key) { at = i; resumeAt = Number(last.time) || 0; break; }
    }
    if (has('setImmersiveMode')) { try { setImmersiveMode(true); } catch (e) { } }
    playList(all, at, resumeAt);
  }
  function seekBy(delta) {
    if (typeof audio === 'undefined' || !audio || !isFinite(audio.duration)) return;
    try { audio.currentTime = Math.max(0, Math.min(audio.duration - 1, audio.currentTime + delta)); } catch (e) { }
    showHud(2600);
  }
  function playPause() {
    if (!currentSong()) { if (songs.length) startPlayback(); return; }
    if (has('togglePlay')) togglePlay();
    setTimeout(function () { showHud(); }, 120);
  }

  // ---- HUD -------------------------------------------------------------------------------
  function paintHud() {
    var song = currentSong();
    if (!song) return;
    var art = thumbUrl(song, 300);
    $('mrtv-hud-title').textContent = song.name || '';
    $('mrtv-hud-sub').textContent = [song.artist, song.album].filter(Boolean).join(' · ');
    $('mrtv-hud-cover').style.backgroundImage = art ? 'url("' + art + '")' : '';
    var cur = 0, dur = 0, paused = true;
    if (typeof audio !== 'undefined' && audio) { cur = audio.currentTime || 0; dur = isFinite(audio.duration) ? audio.duration : (song.mrtvSeconds || (song.localKey ? song.duration : 0) || 0); paused = audio.paused; }
    $('mrtv-hud-fill').style.width = dur > 0 ? (Math.min(1, cur / dur) * 100).toFixed(2) + '%' : '0';
    $('mrtv-hud-time').textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
    $('mrtv-hud-pos').textContent = (currentIdx + 1) + ' / ' + playQueue.length;
    $('mrtv-hud-state').textContent = paused ? '已暂停' : playModeText();
  }
  function playModeText() {
    var m = typeof playMode !== 'undefined' ? playMode : 'loop';
    return m === 'shuffle' ? '随机播放' : m === 'single' ? '单曲循环' : '列表循环';
  }
  function showHud(ms) {
    if (mode !== 'stage') return;
    paintHud();
    $('mrtv-hud').classList.add('show');
    $('mrtv-keys').classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () {
      var paused = typeof audio !== 'undefined' && audio && audio.paused;
      if (paused && mode === 'stage') { showHud(4000); return; }
      $('mrtv-hud').classList.remove('show');
      $('mrtv-keys').classList.remove('show');
    }, ms || 4200);
  }
  function hideHud() { $('mrtv-hud').classList.remove('show'); $('mrtv-keys').classList.remove('show'); }
  setInterval(function () {
    var song = currentSong();
    var key = song ? songKey(song) + '#' + currentIdx : '';
    if (key && key !== lastTrackKey) { lastTrackKey = key; showHud(5200); }
    if ($('mrtv-hud').classList.contains('show')) paintHud();
  }, 500);
  setInterval(function () {
    var song = currentSong();
    if (!song || !song.localKey || typeof audio === 'undefined' || !audio || audio.paused) return;
    writeJson(LAST_KEY, { key: song.localKey, time: Math.floor(audio.currentTime || 0), at: Date.now() });
  }, 5000);

  // ---- Library panel ---------------------------------------------------------------------
  function windowTop(top, idx, count) {
    if (idx < top) top = idx;
    if (idx >= top + ROWS) top = idx - ROWS + 1;
    return Math.max(0, Math.min(top, Math.max(0, count - ROWS)));
  }
  function renderLibrary() {
    var g = groups[lib.group] || groups[0];
    var items = groupItems(g);
    var playingKey = songKey(currentSong());
    lib.groupTop = windowTop(lib.groupTop, lib.group, groups.length);
    lib.track = Math.max(0, Math.min(lib.track, Math.max(0, items.length - 1)));
    lib.trackTop = windowTop(lib.trackTop, lib.track, items.length);
    var gHtml = '';
    for (var i = lib.groupTop; i < Math.min(groups.length, lib.groupTop + ROWS); i++) {
      var gi = groups[i];
      var count = gi.settings || gi.login || gi.qqLogin ? '' : (gi.indexes ? gi.indexes.length : (gi.items ? gi.items.length : ''));
      gHtml += '<div class="mrtv-row' + (i === lib.group ? ' sel' : '') + '"><span class="mrtv-main">' + esc(gi.title) + '</span><span class="mrtv-side">' + esc([gi.note, count].filter(function (v) { return v !== '' && v != null; }).join(' · ')) + '</span></div>';
    }
    var tHtml = '';
    if (g.login) tHtml = '<div class="mrtv-note">按 OK，用手机上的网易云音乐 App 扫码登录。<br>登录后这里会出现每日推荐和你的歌单。</div>';
    else if (g.qqLogin) tHtml = '<div class="mrtv-note">按 OK，用手机 QQ 扫码登录 QQ 音乐。<br>登录后这里会出现你的 QQ 音乐歌单。</div>';
    else if (g.online && !g.items) { tHtml = '<div class="mrtv-note">' + (g.failed ? '没有加载出来，按 OK 再试一次。' : '正在加载…') + '</div>'; if (!g.failed) loadOnlineGroup(g); }
    else if (g.settings) tHtml = '<div class="mrtv-note">按 OK 打开设置。</div>';
    for (var j = lib.trackTop; j < Math.min(items.length, lib.trackTop + ROWS); j++) {
      var t = items[j];
      var art = thumbUrl(t, 100);
      var thumb = art ? ' style="background-image:url(\'' + art + '\')"' : '';
      var seconds = t.mrtvSeconds || (t.localKey ? t.duration : 0);
      tHtml += '<div class="mrtv-row' + (j === lib.track ? ' sel' : '') + (songKey(t) === playingKey ? ' playing' : '') + '"><span class="mrtv-thumb"' + thumb + '></span><span class="mrtv-main">' + esc(t.name) + '</span><span class="mrtv-side">' + esc([t.artist, seconds ? fmtTime(seconds) : ''].filter(Boolean).join(' · ')) + '</span></div>';
    }
    $('mrtv-groups').innerHTML = gHtml;
    $('mrtv-tracks').innerHTML = tHtml;
    $('mrtv-groups').classList.toggle('active', lib.col === 0);
    $('mrtv-tracks').classList.toggle('active', lib.col === 1);
    var note = songs.length ? '本地 ' + songs.length + ' 首' + (libraryInfo.volumes.length ? ' · ' + libraryInfo.volumes.join('、') : '') : '没有本地音乐';
    if (libraryInfo.scanning) note += ' · 正在读取信息…';
    note += online.state === 'ready' ? (' · 网易云' + (online.user ? '已登录' : '未登录') + ' · QQ 音乐' + (online.qq ? '已登录' : '未登录')) : online.state === 'failed' ? ' · 在线音乐不可用' : ' · 在线音乐启动中…';
    $('mrtv-lib-note').textContent = note;
  }
  function openLibrary(keep) {
    if (!groups.length) buildGroups();
    mode = 'library';
    hideHud();
    $('mrtv-empty').classList.remove('show');
    var items = groupItems(groups[lib.group] || groups[0]);
    if (!keep) {
      var key = songKey(currentSong());
      if (key) for (var j = 0; j < items.length; j++) if (songKey(items[j]) === key) { lib.track = j; break; }
      lib.col = items.length ? 1 : 0;
    }
    renderLibrary();
    $('mrtv-library').classList.add('show');
  }
  function libraryKey(key) {
    var g = groups[lib.group] || groups[0];
    var items = groupItems(g);
    if (key === 'left') { if (lib.col === 1) lib.col = 0; }
    else if (key === 'right') { if (lib.col === 0 && items.length) lib.col = 1; }
    else if (key === 'up' || key === 'down') {
      var d = key === 'up' ? -1 : 1;
      if (lib.col === 0) {
        var ng = Math.max(0, Math.min(groups.length - 1, lib.group + d));
        if (ng !== lib.group) { lib.group = ng; lib.track = 0; lib.trackTop = 0; }
      } else {
        lib.track = Math.max(0, Math.min(items.length - 1, lib.track + d));
      }
    } else if (key === 'ok') {
      if (g.settings) { $('mrtv-library').classList.remove('show'); openSettings('library'); return; }
      if (g.login) { $('mrtv-library').classList.remove('show'); openLogin('library'); return; }
      if (g.qqLogin) { openQqLogin(); return; }
      if (g.online && !g.items) { g.failed = false; loadOnlineGroup(g); }
      else if (lib.col === 0) { if (items.length) lib.col = 1; }
      else if (items.length) { playSongs(items, lib.track, 0); closePanels(); return; }
    } else if (key === 'menu') { $('mrtv-library').classList.remove('show'); openSettings('library'); return; }
    if (!groupItems(groups[lib.group] || {}).length) lib.col = 0;
    renderLibrary();
  }

  // ---- NetEase sign-in: a QR code for the phone app ------------------------------------------
  var login = { key: '', timer: 0, from: 'stage' };
  function loginStatus(text, tone) { var n = $('mrtv-login-status'); n.textContent = text; n.className = tone || ''; }
  function stopLoginPoll() { clearInterval(login.timer); login.timer = 0; }
  function newLoginCode() {
    stopLoginPoll();
    $('mrtv-login-qr').removeAttribute('src');
    loginStatus('正在生成二维码…');
    api('/api/login/qr/key').then(function (k) {
      if (!k || !k.key) throw new Error('no key');
      login.key = k.key;
      return api('/api/login/qr/create?key=' + encodeURIComponent(k.key));
    }).then(function (q) {
      if (!q || !q.img) throw new Error('no image');
      if (mode !== 'login') return;
      $('mrtv-login-qr').src = q.img;
      loginStatus('打开手机上的网易云音乐 App，扫一扫');
      login.timer = setInterval(checkLogin, 2000);
    }).catch(function () { loginStatus('二维码没有生成出来，按 OK 再试', 'fail'); });
  }
  function checkLogin() {
    if (mode !== 'login' || !login.key) { stopLoginPoll(); return; }
    api('/api/login/qr/check?key=' + encodeURIComponent(login.key)).then(function (r) {
      if (!r || mode !== 'login') return;
      if (r.code === 800) { stopLoginPoll(); loginStatus('二维码过期了，按 OK 换一个', 'fail'); }
      else if (r.code === 802) loginStatus('已扫码，请在手机上确认', 'ok');
      else if (r.code === 803) {
        stopLoginPoll();
        loginStatus('登录成功', 'ok');
        try { if (has('refreshLoginStatus')) refreshLoginStatus(true); } catch (e) { }
        setTimeout(function () {
          refreshOnline().then(function () {
            $('mrtv-login').classList.remove('show');
            toast('欢迎 ' + ((online.user && online.user.nickname) || ''));
            lib.group = Math.max(0, groups.indexOf(online.groups[0])); lib.track = 0; lib.trackTop = 0; lib.col = 0;
            openLibrary(true);
          });
        }, 900);
      }
    }).catch(function () { });
  }
  function openLogin(from) {
    if (online.state !== 'ready') { toast(online.state === 'failed' ? '在线音乐不可用' : '在线音乐还在启动，稍等几秒'); if (from === 'library') openLibrary(true); else if (from === 'settings') openSettings(settingsFrom); return; }
    login.from = from || 'stage';
    mode = 'login';
    hideHud();
    $('mrtv-login').classList.add('show');
    newLoginCode();
  }
  function logout(provider) {
    api(provider === 'qq' ? '/api/qq/logout' : '/api/logout').catch(function () { }).then(function () {
      try { if (provider !== 'qq' && has('refreshLoginStatus')) refreshLoginStatus(true); } catch (e) { }
      try { if (provider === 'qq' && has('refreshQQLoginStatus')) refreshQQLoginStatus({ forceVip: true, reason: 'tv-logout' }); } catch (e) { }
      return refreshOnline();
    }).then(function () { toast(provider === 'qq' ? '已退出 QQ 音乐账号' : '已退出网易云账号'); renderSettings(); });
  }
  // QQ Music signs in on QQ's own page (a QR code for the phone), which only the TV shell can
  // show: it opens the page over the stage and hands the session to the back end when it is there.
  function openQqLogin() {
    if (online.state !== 'ready') { toast(online.state === 'failed' ? '在线音乐不可用' : '在线音乐还在启动，稍等几秒'); return; }
    if (native && native.loginQQ) native.loginQQ();
    else toast('QQ 音乐的扫码登录只在电视上有，浏览器里试不了', 3200);
  }
  TV.onQqLogin = function (ok) {
    if (!ok) return;
    try { if (has('refreshQQLoginStatus')) refreshQQLoginStatus({ forceVip: true, reason: 'tv-login' }); } catch (e) { }
    refreshOnline().then(function () {
      toast('QQ 音乐已登录' + (online.qq && online.qq.nickname ? '：' + online.qq.nickname : ''));
      if (mode === 'settings') renderSettings();
    });
  };

  // ---- Settings panel --------------------------------------------------------------------
  var QUALITY = ['eco', 'balanced', 'high'];
  var QUALITY_TEXT = { eco: '流畅', balanced: '均衡', high: '精细', ultra: '极致' };
  function presetCount() { return document.querySelectorAll('#preset-grid .preset-card').length; }
  function presetName(i) {
    var card = document.querySelector('#preset-grid .preset-card[data-preset="' + i + '"]');
    var nameEl = card && card.querySelector('.pc-name');
    return ((nameEl && nameEl.textContent) || '').trim().slice(0, 30) || ('视觉 ' + (i + 1));
  }
  /** The visuals in the order Mineradio lists them. */
  function presetOrder() {
    return Array.prototype.map.call(document.querySelectorAll('#preset-grid .preset-card'), function (c) { return Number(c.getAttribute('data-preset')); }).filter(isFinite);
  }
  var visualBusyUntil = 0;
  function cycleVisual(dir) {
    var order = presetOrder();
    if (!order.length || !has('setPreset')) return;
    var now = Date.now();
    if (now < visualBusyUntil) return; // one particle transition at a time
    visualBusyUntil = now + 700;
    var at = order.indexOf(currentPreset());
    var next = order[((at < 0 ? 0 : at) + dir + order.length) % order.length];
    try { setPreset(next); } catch (e) { console.warn('[MRTV] preset', e); return; }
    toast(presetName(next) + '　' + (order.indexOf(next) + 1) + ' / ' + order.length, 1800);
  }
  function currentPreset() { return (typeof fx !== 'undefined' && fx && isFinite(fx.preset)) ? Number(fx.preset) : 0; }
  var settings = [
    { title: '播放顺序', value: playModeText, change: function () { if (has('cyclePlayMode')) cyclePlayMode(); } },
    { title: '视觉效果', value: function () { return presetCount() ? presetName(currentPreset()) + '（' + (presetOrder().indexOf(currentPreset()) + 1) + ' / ' + presetCount() + '）' : '默认'; },
      change: function (d) { cycleVisual(d || 1); } },
    { title: '歌词', value: function () { return (typeof fx !== 'undefined' && fx && fx.particleLyrics) ? '显示' : '隐藏'; },
      change: function () { if (has('setParticleLyricsSilently')) setParticleLyricsSilently(!(fx && fx.particleLyrics)); } },
    { title: '画面精细度', value: function () { var q = (typeof fx !== 'undefined' && fx && fx.performanceQuality) || 'eco'; return QUALITY_TEXT[q] || q; },
      change: function (d) { var q = (fx && fx.performanceQuality) || 'eco'; var i = QUALITY.indexOf(q); i = (Math.max(0, i) + (d || 1) + QUALITY.length) % QUALITY.length; if (has('setPerformanceQualityMode')) setPerformanceQualityMode(QUALITY[i], true); } },
    { title: '节奏分析（镜头随鼓点）', value: function () { return prefs.beat ? '开' : '关'; },
      change: function () { prefs.beat = !prefs.beat; writeJson(PREF_KEY, prefs); } },
    { title: '网易云账号', action: true, value: function () { return online.state !== 'ready' ? (online.state === 'failed' ? '不可用' : '启动中…') : (online.user ? (online.user.nickname || '已登录') + '　OK 退出登录' : '未登录　OK 登录'); },
      change: function () { if (online.user) confirmThen('netease-out', '再按一次 OK 退出网易云账号', function () { logout('netease'); }); else { $('mrtv-settings').classList.remove('show'); openLogin('settings'); } } },
    { title: 'QQ 音乐账号', action: true, value: function () { return online.state !== 'ready' ? (online.state === 'failed' ? '不可用' : '启动中…') : (online.qq ? (online.qq.nickname || '已登录') + '　OK 退出登录' : '未登录　OK 登录'); },
      change: function () { if (online.qq) confirmThen('qq-out', '再按一次 OK 退出 QQ 音乐账号', function () { logout('qq'); }); else openQqLogin(); } },
    { title: '重新扫描音乐', action: true, value: function () { return songs.length + ' 首'; },
      change: function () { api('/tvapi/rescan').then(function () { toast('正在重新扫描…'); setTimeout(function () { loadLibrary('mount'); }, 1500); }).catch(function () { }); } },
    { title: '退出 Mineradio TV', action: true, value: function () { return ''; }, change: function () { exitApp(); } }
  ];
  var pendingConfirm = { id: '', until: 0 };
  /** Things that cannot be taken back with one more press ask for a second OK. */
  function confirmThen(id, text, run) {
    var now = Date.now();
    if (pendingConfirm.id === id && now < pendingConfirm.until) { pendingConfirm.id = ''; run(); return; }
    pendingConfirm = { id: id, until: now + 3500 };
    toast(text, 3200);
  }
  var settingsFrom = 'stage';
  function renderSettings() {
    $('mrtv-settings-list').innerHTML = settings.map(function (s, i) {
      var value = ''; try { value = s.value(); } catch (e) { }
      return '<div class="mrtv-row' + (i === settingsIdx ? ' sel' : '') + '"><span class="mrtv-main">' + esc(s.title) + '</span><span class="mrtv-side">' + (value ? (s.action ? esc(value) : '‹ ' + esc(value) + ' ›') : '') + '</span></div>';
    }).join('');
  }
  function openSettings(from) { settingsFrom = from || 'stage'; mode = 'settings'; hideHud(); $('mrtv-empty').classList.remove('show'); renderSettings(); $('mrtv-settings').classList.add('show'); }
  function settingsKey(key) {
    if (key === 'up') settingsIdx = Math.max(0, settingsIdx - 1);
    else if (key === 'down') settingsIdx = Math.min(settings.length - 1, settingsIdx + 1);
    else if (key === 'ok' || ((key === 'left' || key === 'right') && !settings[settingsIdx].action)) { try { settings[settingsIdx].change(key === 'left' ? -1 : 1); } catch (e) { console.warn('[MRTV] setting', e); } }
    setTimeout(renderSettings, 60);
    renderSettings();
  }
  function closePanels() {
    $('mrtv-library').classList.remove('show');
    $('mrtv-settings').classList.remove('show');
    $('mrtv-login').classList.remove('show');
    stopLoginPoll();
    mode = (songs.length || currentSong()) ? 'stage' : 'empty';
    if (mode === 'empty') showEmpty();
    if (mode === 'stage') showHud(2600);
  }
  function exitApp() {
    if (native && native.exit) native.exit();
    else toast('退出（电视上会关闭应用）');
  }

  // ---- Keys ------------------------------------------------------------------------------
  var KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'ok', NumpadEnter: 'ok', ' ': 'ok',
    Escape: 'back', Backspace: 'back', GoBack: 'back', BrowserBack: 'back',
    MediaPlayPause: 'playpause', MediaPlay: 'playpause', MediaPause: 'playpause',
    MediaTrackNext: 'next', MediaTrackPrevious: 'prev', MediaFastForward: 'ff', MediaRewind: 'rw',
    ContextMenu: 'menu', Tab: 'menu'
  };
  var held = { key: '', repeats: 0 };
  function onBack() {
    // One level at a time: sign-in -> where it was opened from; settings -> the library if it
    // came from there; the track list -> the group list -> the stage.
    if (mode === 'login') {
      $('mrtv-login').classList.remove('show'); stopLoginPoll();
      if (login.from === 'settings') openSettings(settingsFrom);
      else if (login.from === 'library') openLibrary(true);
      else closePanels();
      return true;
    }
    if (mode === 'settings') {
      $('mrtv-settings').classList.remove('show');
      if (settingsFrom === 'library') openLibrary(true); else closePanels();
      return true;
    }
    if (mode === 'library') {
      if (lib.col === 1) { lib.col = 0; renderLibrary(); } else closePanels();
      return true;
    }
    var now = Date.now();
    if (now - lastBackAt < 2500) { exitApp(); return false; }
    lastBackAt = now;
    toast('再按一次返回键退出');
    return true;
  }
  TV.onBack = onBack;
  TV.onKey = function (name) { handle(name, false); };
  function handle(key, repeat) {
    if (key === 'back') { onBack(); return; }
    if (key === 'playpause') { playPause(); return; }
    if (key === 'next') { if (has('nextTrack')) nextTrack(); return; }
    if (key === 'prev') { if (has('prevTrack')) prevTrack(); return; }
    if (key === 'ff') { seekBy(15); return; }
    if (key === 'rw') { seekBy(-15); return; }
    if (mode === 'library') { libraryKey(key); return; }
    if (mode === 'settings') { settingsKey(key); return; }
    if (mode === 'login') { if (key === 'ok') newLoginCode(); return; }
    if (mode === 'empty') {
      if (key === 'ok') {
        if (online.state === 'ready' && libraryInfo.access !== 'none') openLibrary();
        else if (libraryInfo.access === 'none' && native && native.requestAccess) native.requestAccess();
        else api('/tvapi/rescan').then(function () { setTimeout(function () { loadLibrary('mount'); }, 1200); }).catch(function () { });
      } else if (key === 'menu' || key === 'down') openSettings();
      return;
    }
    // Stage: up / down change the visual, left / right the song; OK is answered on release
    // (keyUp), since holding it opens the library.
    if (key === 'ok') { if (repeat) { held.repeats++; if (held.repeats === 3) { held.consumed = true; openLibrary(); } } }
    else if (key === 'up') { if (!repeat) cycleVisual(-1); }
    else if (key === 'down') { if (!repeat) cycleVisual(1); }
    else if (key === 'menu') openSettings();
    else if (key === 'left' || key === 'right') {
      if (repeat) { held.repeats++; if (held.repeats >= 2) seekBy(key === 'left' ? -10 : 10); }
    }
  }
  function keyDown(key, repeat) {
    if (!repeat) { held.key = key; held.repeats = 0; held.mode = mode; held.consumed = false; }
    if (repeat && (key === 'back' || key === 'playpause' || key === 'menu' || key === 'next' || key === 'prev')) return;
    if (repeat && key === 'ok' && mode !== 'stage') return;
    handle(key, repeat);
  }
  function keyUp(key) {
    // A short press of left / right on the stage is previous / next; a hold was a seek.
    if (mode === 'stage' && held.mode === 'stage' && (key === 'left' || key === 'right') && held.key === key && held.repeats < 2) {
      if (key === 'left') { if (has('prevTrack')) prevTrack(); } else if (has('nextTrack')) nextTrack();
    }
    if (key === 'ok' && mode === 'stage' && held.mode === 'stage' && held.key === 'ok' && !held.consumed) playPause();
    held.key = ''; held.repeats = 0;
  }
  /** The TV shell hands remote keys over by name: 'down' with its repeat count, then 'up'. */
  TV.nativeKey = function (name, phase, repeatCount) {
    if (phase === 'down') keyDown(name, Number(repeatCount) > 0); else keyUp(name);
  };
  var pausedByHost = false;
  TV.onHostPause = function () {
    try { if (typeof audio !== 'undefined' && audio && !audio.paused) { pausedByHost = true; if (has('togglePlay')) togglePlay(); else audio.pause(); } } catch (e) { }
  };
  TV.onHostResume = function () {
    if (!pausedByHost) return;
    pausedByHost = false;
    try { if (typeof audio !== 'undefined' && audio && audio.paused && has('togglePlay')) togglePlay(); } catch (e) { }
  };
  window.addEventListener('keydown', function (e) {
    var key = KEYMAP[e.key];
    if (!key) return;
    e.preventDefault(); e.stopImmediatePropagation();
    keyDown(key, e.repeat);
  }, true);
  window.addEventListener('keyup', function (e) {
    var key = KEYMAP[e.key];
    if (!key) return;
    e.preventDefault(); e.stopImmediatePropagation();
    keyUp(key);
  }, true);
  ['mousedown', 'mouseup', 'click', 'mousemove', 'wheel', 'contextmenu'].forEach(function (type) {
    window.addEventListener(type, function (e) { if (!e.isTrusted) return; e.stopImmediatePropagation(); if (type !== 'mousemove') e.preventDefault(); }, true);
  });

  // ---- Mineradio dialogs a TV cannot answer -----------------------------------------------
  function patchMineradio() {
    // Local lyrics come from the TV shell (a same-name .lrc next to the file).
    window.applyLocalTrackLyricOnDemand = function (song, token) {
      if (has('cancelPendingTrackFallbackLyrics')) cancelPendingTrackFallbackLyrics();
      if (song && song.lyric) { applyFetchedLyricResponse(song, token, { lyric: song.lyric }, { persist: false }); return; }
      setOriginalLyricsState(withLyricFallback([]), false, 'fallback');
      applyPreferredLyricsForCurrent(true);
      if (!song || !song.hasLyric || song.mrtvId == null) return;
      api('/tvapi/lyric?id=' + encodeURIComponent(song.mrtvId)).then(function (result) {
        if (token !== trackSwitchToken || !result || !result.lyric) return;
        song.lyric = result.lyric;
        applyFetchedLyricResponse(song, token, { lyric: result.lyric }, { persist: false });
      }).catch(function () { });
    };
    // "Which beat analysis?" has one sensible answer on a TV: the film one, quietly, or none.
    window.openLocalBeatModal = function (song, audioUrl) {
      if (!prefs.beat) return;
      try {
        localBeatAnalysis.song = song || currentLocalSong;
        localBeatAnalysis.audioUrl = audioUrl || (typeof audio !== 'undefined' && audio && audio.src) || '';
        localBeatAnalysis.mode = 'mr';
        localBeatAnalysis.active = false;
        startLocalBeatAnalysis('mr');
      } catch (e) { }
    };
    window.maybeRunStartupLoginGuide = function () { return false; };
    var quietToast = window.showToast;
    if (typeof quietToast === 'function') {
      window.showToast = function (msg) {
        if (/本地节奏缓存已载入|已导入|正在播放本地音乐|登录/.test(String(msg || ''))) return;
        return quietToast.apply(this, arguments);
      };
    }
  }

  // ---- Boot ------------------------------------------------------------------------------
  function ready() { return has('playQueueAt') && has('importLocalAudioSongs') && has('applyFetchedLyricResponse') && typeof playQueue !== 'undefined'; }
  var bootTries = 0;
  (function boot() {
    if (!ready()) {
      if (++bootTries > 400) { toast('界面加载失败', 8000); return; }
      setTimeout(boot, 50);
      return;
    }
    patchMineradio();
    try { if (document.body.classList.contains('splash-active') && has('dismissSplash')) dismissSplash({}); } catch (e) { }
    setTimeout(function () {
      loadLibrary('boot');
      watchBackend();
      setInterval(function () { if (!songs.length || libraryInfo.scanning) loadLibrary('poll'); }, 4000);
    }, 600);
  })();
})();
