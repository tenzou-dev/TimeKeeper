/* StageTimer — dashboard operator */
(function () {
  'use strict';

  var ST = window.StageTimer;
  var params = new URLSearchParams(location.search);
  var room = ST.normalizeRoom(params.get('room'));

  var $ = function (id) {
    return document.getElementById(id);
  };

  var els = {
    conn: $('conn'),
    connText: $('connText'),
    brand: $('brand'),
    roomName: $('roomName'),
    copyLink: $('copyLink'),
    copyLink2: $('copyLink2'),
    openDisplay: $('openDisplay'),
    preview: $('preview'),
    displayUrl: $('displayUrl'),
    hostSelect: $('hostSelect'),
    opTimer: $('opTimer'),
    opStatePill: $('opStatePill'),
    opTimingNote: $('opTimingNote'),
    opEndLabel: $('opEndLabel'),
    opEndTime: $('opEndTime'),
    startPause: $('startPause'),
    startPauseText: $('startPauseText'),
    iconPlay: $('iconPlay'),
    iconPause: $('iconPause'),
    reset: $('reset'),
    durationInput: $('durationInput'),
    applyDuration: $('applyDuration'),
    presets: $('presets'),
    labelInput: $('labelInput'),
    sublabelInput: $('sublabelInput'),
    messageStatus: $('messageStatus'),
    messagePresets: $('messagePresets'),
    messageInput: $('messageInput'),
    messageTone: $('messageTone'),
    messageTtl: $('messageTtl'),
    sendMessage: $('sendMessage'),
    clearMessage: $('clearMessage'),
    rundownForm: $('rundownForm'),
    itemTitle: $('itemTitle'),
    itemSpeaker: $('itemSpeaker'),
    itemMinutes: $('itemMinutes'),
    rundownList: $('rundownList'),
    rundownEmpty: $('rundownEmpty'),
    rundownTotal: $('rundownTotal'),
    clearRundown: $('clearRundown'),
    warnInput: $('warnInput'),
    dangerInput: $('dangerInput'),
    themeSelect: $('themeSelect'),
    showClock: $('showClock'),
    showProgress: $('showProgress'),
    showNext: $('showNext'),
    showStatus: $('showStatus'),
    blink: $('blink'),
    showSublabel: $('showSublabel'),
    roomInput: $('roomInput'),
    changeRoom: $('changeRoom'),
    roomForm: $('roomForm'),
    roomList: $('roomList'),
    roomCount: $('roomCount'),
    roomRow: $('roomRow'),
    toasts: $('toasts'),
    account: $('account'),
    accountEmail: $('accountEmail'),
    accountAvatar: $('accountAvatar'),
    logout: $('logout'),
    footNote: $('footNote'),
  };

  var state = null;
  var offset = 0;
  var labelTimer = null;
  var publicOrigin = location.origin;
  var redirectingToLogin = false;

  var displayPath = '/display?room=' + encodeURIComponent(room);
  var displayUrl = location.origin + displayPath;

  els.roomName.textContent = room;
  els.roomInput.value = '';
  if (els.brand) els.brand.href = '/?room=' + encodeURIComponent(room);
  els.openDisplay.href = displayPath;
  els.preview.src = '/display?preview=1&room=' + encodeURIComponent(room);
  els.displayUrl.textContent = displayUrl;
  document.title = 'StageTimer — ' + room;

  /* ------------------------------------------------------------------ */
  /* Koneksi                                                             */
  /* ------------------------------------------------------------------ */

  var conn = ST.connect(room, {
    onState: function (nextState, serverNow, nextOffset) {
      state = nextState;
      offset = nextOffset;
      render();
    },
    onStatus: setConnection,
  });

  function setConnection(status) {
    els.conn.dataset.state = status;
    els.connText.textContent =
      status === 'online' ? 'Tersambung' : status === 'offline' ? 'Terputus — mencoba' : 'Menghubungkan';
  }

  /* ------------------------------------------------------------------ */
  /* Daftar ruang                                                        */
  /* ------------------------------------------------------------------ */

  var ROOMS_KEY = 'st_room_history';
  var DEFAULT_ROOM_LABEL = 'Pembicara';
  var serverRooms = [];
  var roomEntries = [];
  var lastRoomLabel = null;
  var lastTouchedLabel = null;

  function cleanRoomLabel(value) {
    var label = String(value == null ? '' : value)
      .trim()
      .slice(0, 160);
    return label === DEFAULT_ROOM_LABEL ? '' : label;
  }

  function readRoomHistory() {
    try {
      var parsed = JSON.parse(localStorage.getItem(ROOMS_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(function (item) {
          return item && typeof item.id === 'string' && item.id;
        })
        .map(function (item) {
          return {
            id: ST.normalizeRoom(item.id),
            label: cleanRoomLabel(item.label),
            updatedAt: Number(item.updatedAt) || 0,
          };
        });
    } catch (err) {
      return [];
    }
  }

  function writeRoomHistory(list) {
    try {
      localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, 60)));
    } catch (err) {
      /* localStorage bisa diblokir; daftar server tetap dipakai */
    }
  }

  function mergeRoomList() {
    var map = {};

    readRoomHistory().forEach(function (item) {
      map[item.id] = item;
    });

    serverRooms.forEach(function (item) {
      var entry = map[item.id];
      if (!entry) entry = { id: item.id, label: '', updatedAt: 0 };
      if (item.label) entry.label = item.label;
      entry.updatedAt = Math.max(entry.updatedAt || 0, Number(item.updatedAt) || 0);
      map[item.id] = entry;
    });

    var current = map[room];
    if (!current) current = { id: room, label: '', updatedAt: Date.now() };
    if (state && state.label) {
      var currentLabel = cleanRoomLabel(state.label);
      if (currentLabel) current.label = currentLabel;
    }
    map[room] = current;

    roomEntries = Object.keys(map)
      .map(function (id) {
        return map[id];
      })
      .sort(function (a, b) {
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });

    renderRooms();
  }

  function renderRooms() {
    if (!els.roomList) return;
    els.roomList.textContent = '';
    els.roomCount.textContent = roomEntries.length + ' ruang';

    roomEntries.forEach(function (entry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-item';
      button.dataset.room = entry.id;
      button.title = 'Buka ruang ' + entry.id;

      if (entry.id === room) {
        button.classList.add('is-current');
        button.setAttribute('aria-current', 'true');
      }

      var main = document.createElement('span');
      main.className = 'room-item-main';

      var label = document.createElement('span');
      label.className = 'room-item-label';
      label.textContent = entry.label || entry.id;
      label.title = entry.label ? entry.label + ' · #' + entry.id : entry.id;

      main.appendChild(label);

      if (entry.label) {
        var id = document.createElement('span');
        id.className = 'room-item-id';
        id.textContent = '#' + entry.id;
        main.appendChild(id);
      }

      button.appendChild(main);

      if (entry.id === room) {
        var badge = document.createElement('span');
        badge.className = 'room-item-badge';
        badge.textContent = 'Sekarang';
        button.appendChild(badge);
      } else {
        var arrow = document.createElement('span');
        arrow.className = 'room-item-arrow';
        arrow.textContent = '→';
        button.appendChild(arrow);
      }

      button.addEventListener('click', function () {
        openRoom(entry.id);
      });

      els.roomList.appendChild(button);
    });
  }

  function rememberRoom(id, label) {
    id = ST.normalizeRoom(id);
    var list = readRoomHistory();
    var entry = null;

    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        entry = list[i];
        break;
      }
    }

    var nextLabel = cleanRoomLabel(label);
    if (!entry) {
      entry = { id: id, label: nextLabel, updatedAt: Date.now() };
      list.unshift(entry);
    } else {
      if (nextLabel) entry.label = nextLabel;
      entry.updatedAt = Date.now();
    }

    writeRoomHistory(list);
    mergeRoomList();
  }

  function touchRoom(label) {
    var value = cleanRoomLabel(label);
    if (lastTouchedLabel === value) return;
    lastTouchedLabel = value;

    fetch('/api/rooms/touch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ room: room, label: value }),
    }).catch(function () {
      /* daftar ruang tidak boleh mengganggu operasi timer */
    });
  }

  function openRoom(id) {
    var next = ST.normalizeRoom(id);
    if (next === room) {
      toast('Kamu sudah berada di ruang ini.', 'ok');
      return;
    }
    rememberRoom(next, '');
    location.href = '/?room=' + encodeURIComponent(next);
  }

  function loadRoomList() {
    fetch('/api/rooms', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('rooms');
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.ok || !Array.isArray(data.rooms)) return;
        serverRooms = data.rooms
          .filter(function (item) {
            return item && item.id;
          })
          .map(function (item) {
            return {
              id: ST.normalizeRoom(item.id),
              label: cleanRoomLabel(item.label),
              updatedAt: Number(item.updatedAt) || 0,
            };
          });
        mergeRoomList();
      })
      .catch(function () {
        /* versi offline / sesi berakhir: pakai riwayat browser */
      });
  }

  rememberRoom(room, '');
  loadRoomList();

  /* ------------------------------------------------------------------ */
  /* Akun & sesi (versi online)                                          */
  /* ------------------------------------------------------------------ */

  function redirectToLogin() {
    if (redirectingToLogin) return;
    redirectingToLogin = true;
    location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search));
  }

  function handleAuthError(err) {
    if (!err || err.code !== 'UNAUTH') return false;
    redirectToLogin();
    return true;
  }

  fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('config');
      return res.json();
    })
    .then(function (config) {
      if (!config || !config.online) return;

      if (els.footNote) {
        els.footNote.textContent =
          'StageTimer online · data tersimpan di Cloudflare · layar panggung bisa dibuka tanpa login.';
      }

      return fetch('/api/me', { headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) return null;
          return res.json();
        })
        .then(function (data) {
          if (!data || !data.ok) return;

          var login = String(data.login || '');
          var email = String(data.email || '');
          var name = String(data.name || '');
          var label = name || (login ? '@' + login : email) || 'Akun';

          els.account.hidden = false;
          els.accountEmail.textContent = label;
          els.accountEmail.title = email || login || label;
          els.accountAvatar.textContent = (name || login || email || 'O')
            .charAt(0)
            .toUpperCase();

          if (data.provider === 'github') {
            els.roomRow.hidden = true;
            if (login) {
              els.roomName.textContent = login;
              document.title = 'StageTimer — @' + login;
            }
            if (els.footNote) {
              els.footNote.textContent =
                'StageTimer online · ruang akun GitHub @' +
                (login || '') +
                ' · layar panggung bisa dibuka tanpa login.';
            }
          }
        });
    })
    .catch(function () {
      /* versi lokal / offline: tidak ada akun */
    });

  els.logout.addEventListener('click', async function () {
    els.logout.disabled = true;
    try {
      await fetch('/api/logout', {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      /* tetap arahkan ke login */
    }
    location.replace('/login');
  });

  /* Alamat untuk device lain: kalau dashboard dibuka via localhost,
     pakai IP LAN yang dilaporkan server. Bila ada beberapa adapter,
     operator bisa memilih IP yang satu jaringan dengan device panggung. */
  var infoReady = fetch('/api/info')
    .then(function (res) {
      return res.json();
    })
    .then(function (info) {
      if (!info || !Array.isArray(info.lanAddresses) || !info.lanAddresses.length) return;
      var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
      if (!isLocal) return;

      publicOrigin = 'http://' + info.lanAddresses[0] + ':' + info.port;
      updateDisplayUrl();
      els.displayUrl.title = 'Link ini bisa dibuka dari HP/laptop lain di jaringan yang sama';

      if (info.lanAddresses.length > 1) {
        els.hostSelect.hidden = false;
        info.lanAddresses.forEach(function (ip) {
          var option = document.createElement('option');
          option.value = 'http://' + ip + ':' + info.port;
          option.textContent = ip;
          els.hostSelect.appendChild(option);
        });
        els.hostSelect.value = publicOrigin;
      }
    })
    .catch(function () {
      /* diabaikan */
    });

  function updateDisplayUrl() {
    displayUrl = publicOrigin + displayPath;
    els.displayUrl.textContent = displayUrl;
  }

  els.hostSelect.addEventListener('change', function () {
    publicOrigin = els.hostSelect.value || location.origin;
    updateDisplayUrl();
  });

  /* ------------------------------------------------------------------ */
  /* Aksi                                                                */
  /* ------------------------------------------------------------------ */

  async function send(action, successMessage) {
    try {
      await ST.sendAction(room, action);
      if (successMessage) toast(successMessage, 'ok');
      return true;
    } catch (err) {
      if (handleAuthError(err)) return false;
      toast(err.message || 'Gagal mengirim perintah.', 'error');
      return false;
    }
  }

  function toast(message, tone) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.dataset.tone = tone || '';
    el.textContent = message;
    els.toasts.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s ease, transform .2s ease';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      setTimeout(function () {
        el.remove();
      }, 230);
    }, 2600);
  }

  function toggleTimer() {
    if (!state) return;
    send({ type: state.running ? 'pause' : 'start' });
  }

  function applyDuration() {
    var ms = ST.parseDurationInput(els.durationInput.value);
    if (!ms) {
      toast('Format durasi tidak valid. Contoh: 15 atau 15:30.', 'error');
      els.durationInput.focus();
      els.durationInput.select();
      return;
    }
    send({ type: 'setDurationMs', ms: ms }, 'Durasi diatur ke ' + ST.formatTime(ms) + '.');
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */

  var lastTimerText = null;
  var lastEndText = null;

  function render() {
    if (!state) return;
    renderTimer();
    syncFields();
    renderPresets();
    renderRundown();
    renderMessageStatus();
    syncRoomLabel();
  }

  function syncRoomLabel() {
    var label = cleanRoomLabel(state.label);
    if (label === lastRoomLabel) return;
    lastRoomLabel = label;
    rememberRoom(room, label);
    touchRoom(label);
  }

  function renderTimer() {
    if (!state) return;

    var now = Date.now() + offset;
    var remaining = state.running ? state.endsAt - now : state.remainingMs;
    var level = ST.levelFor(remaining, state.settings);

    var text = ST.formatTime(remaining);
    if (text !== lastTimerText) {
      els.opTimer.textContent = text;
      lastTimerText = text;
    }
    els.opTimer.dataset.level = level;

    var pillState = remaining < 0 ? 'over' : state.running ? 'running' : remaining < state.durationMs ? 'paused' : 'idle';
    els.opStatePill.dataset.state = pillState;
    els.opStatePill.textContent =
      pillState === 'running'
        ? 'Berjalan'
        : pillState === 'over'
          ? 'Waktu habis'
          : pillState === 'paused'
            ? 'Jeda'
            : 'Siap';

    els.startPauseText.textContent = state.running
      ? 'Jeda'
      : remaining < 0
        ? 'Mulai ulang'
        : remaining < state.durationMs
          ? 'Lanjutkan'
          : 'Mulai';
    if (state.running) {
      els.iconPlay.setAttribute('hidden', '');
      els.iconPause.removeAttribute('hidden');
    } else {
      els.iconPlay.removeAttribute('hidden');
      els.iconPause.setAttribute('hidden', '');
    }
    els.startPause.classList.toggle('btn-primary', !state.running);
    els.startPause.classList.toggle('btn-warn', state.running);

    var note;
    if (remaining < 0) {
      note = 'Melewati batas ' + ST.formatTime(-remaining) + (state.running ? ' · berjalan' : ' · dijeda');
    } else if (state.running) {
      note = state.startedAt
        ? 'Durasi ' + ST.formatTime(state.durationMs) + ' · mulai ' + ST.formatClock(new Date(state.startedAt))
        : 'Durasi ' + ST.formatTime(state.durationMs);
    } else if (remaining < state.durationMs) {
      note = 'Jeda · durasi ' + ST.formatTime(state.durationMs);
    } else {
      note = 'Durasi ' + ST.formatTime(state.durationMs) + ' · belum berjalan';
    }
    if (els.opTimingNote.textContent !== note) els.opTimingNote.textContent = note;

    var endTime = now + remaining;
    var endText = ST.formatClock(new Date(endTime));
    if (endText !== lastEndText) {
      els.opEndTime.textContent = endText;
      lastEndText = endText;
    }
    els.opEndLabel.textContent =
      remaining < 0 ? 'Lewat pukul' : state.running ? 'Selesai pukul' : 'Rencana selesai';
  }

  function minutesValue(ms) {
    var minutes = Math.round((Number(ms) || 0) / 600) / 100;
    return String(minutes);
  }

  function syncFields() {
    if (!state) return;

    if (document.activeElement !== els.labelInput) els.labelInput.value = state.label || '';
    if (document.activeElement !== els.sublabelInput) els.sublabelInput.value = state.sublabel || '';
    if (document.activeElement !== els.durationInput) {
      els.durationInput.value = ST.durationInputValue(state.durationMs);
    }
    if (document.activeElement !== els.warnInput) {
      els.warnInput.value = minutesValue(state.settings.warnAtMs);
    }
    if (document.activeElement !== els.dangerInput) {
      els.dangerInput.value = minutesValue(state.settings.dangerAtMs);
    }

    els.themeSelect.value = state.settings.theme === 'light' ? 'light' : 'dark';
    els.showClock.checked = state.settings.showClock !== false;
    els.showProgress.checked = state.settings.showProgress !== false;
    els.showNext.checked = state.settings.showNext !== false;
    els.showStatus.checked = state.settings.showStatus !== false;
    els.blink.checked = state.settings.blink !== false;
    els.showSublabel.checked = state.settings.showSublabel !== false;
  }

  function renderPresets() {
    if (!state) return;
    var buttons = els.presets.querySelectorAll('button[data-min]');
    for (var i = 0; i < buttons.length; i++) {
      var ms = Number(buttons[i].dataset.min) * 60000;
      buttons[i].classList.toggle('is-active', Math.abs(state.durationMs - ms) < 1000);
    }
  }

  function renderRundown() {
    if (!state) return;
    var list = state.rundown || [];
    var scrollTop = els.rundownList.scrollTop;

    els.rundownList.textContent = '';
    var totalMinutes = 0;

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      totalMinutes += Number(item.minutes) || 0;

      var li = document.createElement('li');
      li.className = 'rundown-item' + (item.id === state.currentItemId ? ' is-current' : '');
      li.dataset.id = item.id;

      var index = document.createElement('span');
      index.className = 'rundown-index';
      index.textContent = String(i + 1).padStart(2, '0');

      var text = document.createElement('div');
      text.className = 'rundown-text';

      var title = document.createElement('div');
      title.className = 'rundown-title';
      title.textContent = item.title;
      title.title = item.title;

      var sub = document.createElement('div');
      sub.className = 'rundown-sub';
      sub.textContent =
        (item.speaker ? item.speaker + ' · ' : '') + ST.formatMinutes(item.minutes);
      sub.title = sub.textContent;

      text.appendChild(title);
      text.appendChild(sub);

      var actions = document.createElement('div');
      actions.className = 'rundown-actions';
      actions.appendChild(makeButton('Muat', 'load', 'btn btn-sm', 'Muat sesi ini ke timer'));
      actions.appendChild(makeButton('↑', 'up', 'icon-btn', 'Naikkan', i === 0));
      actions.appendChild(makeButton('↓', 'down', 'icon-btn', 'Turunkan', i === list.length - 1));
      actions.appendChild(makeButton('×', 'remove', 'icon-btn', 'Hapus'));

      li.appendChild(index);
      li.appendChild(text);
      li.appendChild(actions);
      els.rundownList.appendChild(li);
    }

    els.rundownList.scrollTop = scrollTop;
    els.rundownEmpty.hidden = list.length > 0;
    els.clearRundown.disabled = list.length === 0;
    els.rundownTotal.textContent = list.length
      ? list.length + ' sesi · ' + ST.formatMinutes(totalMinutes)
      : '0 sesi';
  }

  function makeButton(label, act, className, title, disabled) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.act = act;
    button.textContent = label;
    if (title) button.title = title;
    if (disabled) button.disabled = true;
    return button;
  }

  function renderMessageStatus() {
    if (!state) return;
    var now = Date.now() + offset;
    var message = state.message && (state.message.until == null || state.message.until > now) ? state.message : null;
    els.messageStatus.textContent = message ? 'Tampil: “' + message.text + '”' : 'Tidak ada pesan';
    els.messageStatus.title = message ? message.text : '';
    els.clearMessage.disabled = !message;
  }

  /* ------------------------------------------------------------------ */
  /* Event handler                                                       */
  /* ------------------------------------------------------------------ */

  els.startPause.addEventListener('click', toggleTimer);

  function resetTimer() {
    if (!state) return;
    if (state.running && !confirm('Reset timer saat sedang berjalan?')) return;
    send({ type: 'reset' }, 'Timer di-reset.');
  }

  els.reset.addEventListener('click', resetTimer);

  els.applyDuration.addEventListener('click', applyDuration);
  els.durationInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyDuration();
    }
  });

  els.presets.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-min]');
    if (!button) return;
    var ms = Number(button.dataset.min) * 60000;
    if (!ms) return;
    send({ type: 'setDurationMs', ms: ms }, 'Durasi ' + ST.formatTime(ms) + '.');
  });

  document.querySelectorAll('[data-add]').forEach(function (button) {
    button.addEventListener('click', function () {
      var ms = Number(button.dataset.add);
      if (!ms) return;
      send({ type: 'addMs', ms: ms });
    });
  });

  function sendLabel() {
    if (!state) return;
    clearTimeout(labelTimer);
    labelTimer = setTimeout(function () {
      ST.sendAction(room, {
        type: 'setMeta',
        label: els.labelInput.value,
        sublabel: els.sublabelInput.value,
      }).catch(function (err) {
        if (handleAuthError(err)) return;
        toast(err.message, 'error');
      });
    }, 350);
  }

  els.labelInput.addEventListener('input', sendLabel);
  els.sublabelInput.addEventListener('input', sendLabel);
  els.labelInput.addEventListener('blur', function () {
    clearTimeout(labelTimer);
    sendLabel();
  });
  els.sublabelInput.addEventListener('blur', function () {
    clearTimeout(labelTimer);
    sendLabel();
  });

  els.messagePresets.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-text]');
    if (!button) return;
    send({
      type: 'message',
      text: button.dataset.text,
      tone: button.dataset.tone || 'info',
      ttlMs: Number(els.messageTtl.value) || 0,
    });
  });

  els.sendMessage.addEventListener('click', function () {
    var text = els.messageInput.value.trim();
    if (!text) {
      els.messageInput.focus();
      return;
    }
    send({
      type: 'message',
      text: text,
      tone: els.messageTone.value,
      ttlMs: Number(els.messageTtl.value) || 0,
    });
    els.messageInput.value = '';
  });

  els.messageInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.sendMessage.click();
    }
  });

  els.clearMessage.addEventListener('click', function () {
    send({ type: 'clearMessage' }, 'Pesan dihapus.');
  });

  els.rundownForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var title = els.itemTitle.value.trim();
    if (!title) {
      els.itemTitle.focus();
      return;
    }
    var minutes = Number(els.itemMinutes.value);
    if (!isFinite(minutes) || minutes <= 0) {
      toast('Durasi sesi harus lebih dari 0 menit.', 'error');
      els.itemMinutes.focus();
      return;
    }
    send(
      {
        type: 'rundown:add',
        title: title,
        speaker: els.itemSpeaker.value.trim(),
        minutes: minutes,
      },
      'Sesi ditambahkan.'
    );
    els.itemTitle.value = '';
    els.itemSpeaker.value = '';
    els.itemMinutes.value = '15';
    els.itemTitle.focus();
  });

  els.rundownList.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var item = button.closest('.rundown-item');
    if (!item) return;
    var id = item.dataset.id;
    var act = button.dataset.act;

    if (act === 'load') {
      send({ type: 'loadItem', id: id });
    } else if (act === 'up' || act === 'down') {
      send({ type: 'rundown:move', id: id, dir: act });
    } else if (act === 'remove') {
      if (confirm('Hapus sesi ini dari rundown?')) send({ type: 'rundown:remove', id: id });
    }
  });

  els.clearRundown.addEventListener('click', function () {
    if (!state || !state.rundown.length) return;
    if (!confirm('Kosongkan seluruh rundown? Timer yang sedang berjalan tidak terpengaruh.')) return;
    send({ type: 'rundown:clear' }, 'Rundown dikosongkan.');
  });

  function sendSettings(patch) {
    send({ type: 'setSettings', settings: patch });
  }

  els.warnInput.addEventListener('change', function () {
    var value = Number(els.warnInput.value);
    if (!isFinite(value) || value < 0) return;
    sendSettings({ warnAtMs: Math.round(value * 60000) });
  });

  els.dangerInput.addEventListener('change', function () {
    var value = Number(els.dangerInput.value);
    if (!isFinite(value) || value < 0) return;
    sendSettings({ dangerAtMs: Math.round(value * 60000) });
  });

  els.themeSelect.addEventListener('change', function () {
    sendSettings({ theme: els.themeSelect.value === 'light' ? 'light' : 'dark' });
  });

  [
    ['showClock', 'showClock'],
    ['showProgress', 'showProgress'],
    ['showNext', 'showNext'],
    ['showStatus', 'showStatus'],
    ['blink', 'blink'],
    ['showSublabel', 'showSublabel'],
  ].forEach(function (pair) {
    var input = els[pair[0]];
    input.addEventListener('change', function () {
      var patch = {};
      patch[pair[1]] = input.checked;
      sendSettings(patch);
    });
  });

  els.roomForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!els.roomInput.value.trim()) {
      els.roomInput.focus();
      return;
    }
    openRoom(ST.normalizeRoom(els.roomInput.value));
  });

  function copyDisplayLink() {
    infoReady
      .then(function () {
        return ST.copyText(displayUrl);
      })
      .then(
        function () {
          toast('Link layar disalin: ' + displayUrl, 'ok');
        },
        function (err) {
          toast(err.message || 'Gagal menyalin link.', 'error');
        }
      );
  }

  els.copyLink.addEventListener('click', copyDisplayLink);
  els.copyLink2.addEventListener('click', copyDisplayLink);

  /* Shortcut keyboard -------------------------------------------------- */
  document.addEventListener('keydown', function (event) {
    var target = event.target;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

    if (event.code === 'Space') {
      event.preventDefault();
      toggleTimer();
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      resetTimer();
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      send({ type: 'addMs', ms: 60000 });
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      send({ type: 'addMs', ms: -60000 });
    }
  });

  setInterval(renderTimer, 100);
  setInterval(renderMessageStatus, 1000);

  window.addEventListener('beforeunload', function () {
    conn.close();
  });
})();
