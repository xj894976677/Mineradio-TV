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
  var TV = window.MRTV = { version: '0.1.0' };
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
    '<div id="mrtv-keys"><div><b>◀ ▶</b>上一首 / 下一首（长按快进）<b>▲ ▼</b>切换视觉</div><div><b>OK</b>播放 / 暂停（长按打开曲库）<b>菜单</b>设置</div></div>' +
    '<div id="mrtv-toast"></div>' +
    '<div id="mrtv-empty"><h1 id="mrtv-empty-title"></h1><p id="mrtv-empty-line1"></p><p id="mrtv-empty-line2"></p><div class="mrtv-btn" id="mrtv-empty-btn"></div></div>' +
    '<div class="mrtv-panel" id="mrtv-library"><h2>曲库<small id="mrtv-lib-note"></small></h2>' +
    '<div id="mrtv-lib-body"><div class="mrtv-col" id="mrtv-groups"></div><div class="mrtv-col" id="mrtv-tracks"></div></div>' +
    '<div class="mrtv-foot">▲▼ 选择　◀▶ 切换分类和歌曲　OK 播放　菜单 设置　返回 关闭</div></div>' +
    '<div class="mrtv-panel" id="mrtv-settings"><h2>设置</h2><div id="mrtv-settings-list"></div>' +
    '<div class="mrtv-foot">▲▼ 选择　◀▶ 或 OK 更改　返回 关闭</div></div>';
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
  function buildGroups() {
    var all = songs.map(function (_, i) { return i; });
    var out = [{ title: '全部歌曲', note: '', indexes: all }];
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
  }
  function setLibrary(payload) {
    libraryInfo = { access: payload.access || 'none', scanning: !!payload.scanning, volumes: payload.volumes || [] };
    var next = Array.isArray(payload.tracks) ? payload.tracks : [];
    var same = next.length === tracks.length && next.every(function (t, i) { return tracks[i].key === t.key && tracks[i].name === t.name && tracks[i].hasCover === t.hasCover; });
    if (same) return false;
    tracks = next;
    songs = tracks.map(toSong);
    buildGroups();
    lib.group = Math.min(lib.group, groups.length - 1);
    lib.track = 0; lib.trackTop = 0;
    return true;
  }
  function loadLibrary(reason) {
    return api('/tvapi/library').then(function (payload) {
      var changed = setLibrary(payload || {});
      if (!songs.length) { showEmpty(); if (!libraryInfo.scanning) dismissTitle(); return; }
      hideEmpty();
      dismissTitle();
      if (!started) { started = true; startPlayback(); }
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
  function playList(indexes, at, resumeAt) {
    var list = indexes.map(function (i) { return Object.assign({}, songs[i]); });
    if (!list.length) return;
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
    var all = groups[0].indexes;
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
    var track = currentTrack();
    $('mrtv-hud-title').textContent = song.name || '';
    $('mrtv-hud-sub').textContent = [song.artist, song.album].filter(Boolean).join(' · ');
    $('mrtv-hud-cover').style.backgroundImage = track && track.hasCover ? 'url("' + coverUrl(track) + '")' : '';
    var cur = 0, dur = 0, paused = true;
    if (typeof audio !== 'undefined' && audio) { cur = audio.currentTime || 0; dur = isFinite(audio.duration) ? audio.duration : (song.duration || 0); paused = audio.paused; }
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
    var key = song ? song.localKey + '#' + currentIdx : '';
    if (key && key !== lastTrackKey) { lastTrackKey = key; showHud(5200); }
    if ($('mrtv-hud').classList.contains('show')) paintHud();
  }, 500);
  setInterval(function () {
    var song = currentSong();
    if (!song || typeof audio === 'undefined' || !audio || audio.paused) return;
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
    var playingKey = currentSong() ? currentSong().localKey : '';
    lib.groupTop = windowTop(lib.groupTop, lib.group, groups.length);
    lib.trackTop = windowTop(lib.trackTop, lib.track, g.indexes.length);
    var gHtml = '';
    for (var i = lib.groupTop; i < Math.min(groups.length, lib.groupTop + ROWS); i++) {
      gHtml += '<div class="mrtv-row' + (i === lib.group ? ' sel' : '') + '"><span class="mrtv-main">' + esc(groups[i].title) + '</span><span class="mrtv-side">' + esc(groups[i].note ? groups[i].note + ' · ' : '') + (groups[i].settings ? '' : groups[i].indexes.length) + '</span></div>';
    }
    var tHtml = '';
    for (var j = lib.trackTop; j < Math.min(g.indexes.length, lib.trackTop + ROWS); j++) {
      var t = tracks[g.indexes[j]];
      var thumb = t.hasCover ? ' style="background-image:url(\'' + coverUrl(t) + '\')"' : '';
      tHtml += '<div class="mrtv-row' + (j === lib.track ? ' sel' : '') + (t.key === playingKey ? ' playing' : '') + '"><span class="mrtv-thumb"' + thumb + '></span><span class="mrtv-main">' + esc(t.name) + '</span><span class="mrtv-side">' + esc([t.artist, t.duration ? fmtTime(t.duration) : ''].filter(Boolean).join(' · ')) + '</span></div>';
    }
    $('mrtv-groups').innerHTML = gHtml;
    $('mrtv-tracks').innerHTML = tHtml;
    $('mrtv-groups').classList.toggle('active', lib.col === 0);
    $('mrtv-tracks').classList.toggle('active', lib.col === 1);
    $('mrtv-lib-note').textContent = songs.length + ' 首' + (libraryInfo.volumes.length ? ' · ' + libraryInfo.volumes.join('、') : '') + (libraryInfo.scanning ? ' · 正在读取信息…' : '');
  }
  function openLibrary() {
    if (!songs.length) return;
    mode = 'library';
    hideHud();
    var song = currentSong();
    var g = groups[lib.group] || groups[0];
    if (song) {
      for (var j = 0; j < g.indexes.length; j++) if (tracks[g.indexes[j]].key === song.localKey) { lib.track = j; break; }
    }
    lib.col = 1;
    renderLibrary();
    $('mrtv-library').classList.add('show');
  }
  function libraryKey(key) {
    var g = groups[lib.group] || groups[0];
    if (key === 'left') { if (lib.col === 1) lib.col = 0; }
    else if (key === 'right') { if (lib.col === 0) lib.col = 1; }
    else if (key === 'up' || key === 'down') {
      var d = key === 'up' ? -1 : 1;
      if (lib.col === 0) {
        var ng = Math.max(0, Math.min(groups.length - 1, lib.group + d));
        if (ng !== lib.group) { lib.group = ng; lib.track = 0; lib.trackTop = 0; }
      } else {
        lib.track = Math.max(0, Math.min(g.indexes.length - 1, lib.track + d));
      }
    } else if (key === 'ok') {
      if (g.settings) { $('mrtv-library').classList.remove('show'); openSettings(); return; }
      if (lib.col === 0) lib.col = 1;
      else if (g.indexes.length) { playList(g.indexes, lib.track, 0); closePanels(); return; }
    } else if (key === 'menu') { $('mrtv-library').classList.remove('show'); openSettings(); return; }
    if ((groups[lib.group] || {}).settings) lib.col = 0;
    renderLibrary();
  }

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
    { title: '重新扫描音乐', value: function () { return songs.length + ' 首'; },
      change: function () { api('/tvapi/rescan').then(function () { toast('正在重新扫描…'); setTimeout(function () { loadLibrary('mount'); }, 1500); }).catch(function () { }); } },
    { title: '退出 Mineradio TV', value: function () { return ''; }, change: function () { exitApp(); } }
  ];
  function renderSettings() {
    $('mrtv-settings-list').innerHTML = settings.map(function (s, i) {
      var value = ''; try { value = s.value(); } catch (e) { }
      return '<div class="mrtv-row' + (i === settingsIdx ? ' sel' : '') + '"><span class="mrtv-main">' + esc(s.title) + '</span><span class="mrtv-side">' + (value ? '‹ ' + esc(value) + ' ›' : '') + '</span></div>';
    }).join('');
  }
  function openSettings() { mode = 'settings'; hideHud(); renderSettings(); $('mrtv-settings').classList.add('show'); }
  function settingsKey(key) {
    if (key === 'up') settingsIdx = Math.max(0, settingsIdx - 1);
    else if (key === 'down') settingsIdx = Math.min(settings.length - 1, settingsIdx + 1);
    else if (key === 'left' || key === 'right' || key === 'ok') { try { settings[settingsIdx].change(key === 'left' ? -1 : 1); } catch (e) { console.warn('[MRTV] setting', e); } }
    setTimeout(renderSettings, 60);
    renderSettings();
  }
  function closePanels() {
    $('mrtv-library').classList.remove('show');
    $('mrtv-settings').classList.remove('show');
    mode = songs.length ? 'stage' : 'empty';
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
    ContextMenu: 'menu'
  };
  var held = { key: '', repeats: 0 };
  function onBack() {
    if (mode === 'library' || mode === 'settings') { closePanels(); return true; }
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
    if (mode === 'empty') {
      if (key === 'ok') {
        if (libraryInfo.access === 'none' && native && native.requestAccess) native.requestAccess();
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
      setInterval(function () { if (!songs.length || libraryInfo.scanning) loadLibrary('poll'); }, 4000);
    }, 600);
  })();
})();
