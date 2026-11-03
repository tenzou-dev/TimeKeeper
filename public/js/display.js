/* StageTimer — layar panggung */
(function () {
  'use strict';

  var ST = window.StageTimer;
  var params = new URLSearchParams(location.search);
  var room = ST.normalizeRoom(params.get('room'));
  var preview = params.get('preview') === '1';
  var CACHE_KEY = 'stagetimer:display:' + room;

  if (preview) document.body.classList.add('preview');

  var stage = document.getElementById('stage');
  var els = {
    label: document.getElementById('label'),
    sublabel: document.getElementById('sublabel'),
    timer: document.getElementById('timer'),
    flag: document.getElementById('flag'),
    message: document.getElementById('message'),
    progressWrap: document.getElementById('progressWrap'),
    progress: document.getElementById('progress'),
    next: document.getElementById('next'),
    clock: document.getElementById('clock'),
    status: document.getElementById('status'),
    hint: document.getElementById('hint'),
  };

  var state = null;
  var offset = 0;
  var lastTimerText = null;
  var lastLevel = null;
  var lastMessageKey = null;
  var lastTheme = null;
  var lastBlink = null;
  var lastHideStatus = null;
  var lastLabel = null;
  var lastSublabel = null;
  var lastNext = null;
  var lastClock = null;
  var cursorTimer = null;
  var wakeLock = null;

  /* Cache lokal: tampilan langsung benar saat halaman di-refresh. */
  try {
    var cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && cached.state) {
      state = cached.state;
      offset = (Number(cached.serverNow) || Date.now()) - Date.now();
    }
  } catch (e) {
    /* diabaikan */
  }

  var conn = ST.connect(room, {
    onState: function (nextState, serverNow, nextOffset) {
      state = nextState;
      offset = nextOffset;
      render(serverNow);
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ state: nextState, serverNow: serverNow }));
      } catch (e) {
        /* kuota penuh — abaikan */
      }
    },
    onStatus: function (status) {
      els.status.dataset.status = status;
      els.status.title = status === 'online' ? 'Terhubung' : 'Koneksi terputus — mencoba lagi';
    },
  });

  function currentItemIndex() {
    if (!state) return -1;
    return (state.rundown || []).findIndex(function (item) {
      return item.id === state.currentItemId;
    });
  }

  function nextItemText() {
    if (!state || !state.settings || state.settings.showNext === false) return '';
    var list = state.rundown || [];
    var index = currentItemIndex();
    if (index < 0 || index + 1 >= list.length) return '';
    return 'Berikutnya: ' + list[index + 1].title;
  }

  function render(serverNowOverride) {
    if (!state) return;

    var now = typeof serverNowOverride === 'number' ? serverNowOverride : Date.now() + offset;
    var remaining = state.running ? state.endsAt - now : state.remainingMs;
    var level = ST.levelFor(remaining, state.settings);

    if (level !== lastLevel) {
      stage.dataset.level = level;
      lastLevel = level;
    }

    var text = ST.formatTime(remaining);
    if (text !== lastTimerText) {
      els.timer.textContent = text;
      els.timer.dataset.long = text.length > 7 ? 'xlong' : text.length > 5 ? 'true' : 'false';
      lastTimerText = text;
    }

    els.flag.hidden = level !== 'over';

    var showSublabel = state.settings.showSublabel !== false;
    var sublabel = showSublabel ? state.sublabel || '' : '';
    if (state.label !== lastLabel) {
      els.label.textContent = state.label || '';
      lastLabel = state.label;
    }
    if (sublabel !== lastSublabel) {
      els.sublabel.textContent = sublabel;
      lastSublabel = sublabel;
    }

    var theme = state.settings.theme === 'light' ? 'light' : 'dark';
    if (theme !== lastTheme) {
      stage.dataset.theme = theme;
      lastTheme = theme;
    }

    var blink = state.settings.blink !== false ? 'true' : 'false';
    if (blink !== lastBlink) {
      stage.dataset.blink = blink;
      lastBlink = blink;
    }

    var hideStatus = state.settings.showStatus === false ? 'true' : 'false';
    if (hideStatus !== lastHideStatus) {
      stage.dataset.hideStatus = hideStatus;
      lastHideStatus = hideStatus;
    }

    var message =
      state.message && (state.message.until == null || state.message.until > now) ? state.message : null;
    var messageKey = message ? message.text + '|' + message.tone : '';
    if (messageKey !== lastMessageKey) {
      lastMessageKey = messageKey;
      if (message) {
        els.message.textContent = message.text;
        els.message.dataset.tone = message.tone || 'info';
        els.message.hidden = false;
      } else {
        els.message.hidden = true;
      }
    }

    var showProgress = state.settings.showProgress !== false;
    els.progressWrap.style.display = showProgress ? '' : 'none';
    if (showProgress) {
      var pct = state.durationMs > 0 ? Math.max(0, Math.min(1, remaining / state.durationMs)) : 0;
      els.progress.style.width = (pct * 100).toFixed(2) + '%';
    }

    var nextText = nextItemText();
    if (nextText !== lastNext) {
      els.next.textContent = nextText;
      lastNext = nextText;
    }

    var clockText = state.settings.showClock !== false ? ST.formatClock(new Date(now)) : '';
    if (clockText !== lastClock) {
      els.clock.textContent = clockText;
      lastClock = clockText;
    }
  }

  /* Loop render 10 fps; hemat CPU, tetap mulus untuk progress bar. */
  var lastTick = 0;
  function loop(timestamp) {
    requestAnimationFrame(loop);
    if (timestamp - lastTick < 100) return;
    lastTick = timestamp;
    render();
  }
  requestAnimationFrame(loop);

  /* Layar penuh, kursor, dan wake lock ------------------------------- */
  function toggleFullscreen() {
    if (preview) return;
    if (!document.fullscreenElement) {
      var request = document.documentElement.requestFullscreen;
      if (request) {
        request.call(document.documentElement).catch(function () {
          /* browser menolak tanpa gesture — diabaikan */
        });
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  }

  function hideHint() {
    els.hint.classList.add('is-hidden');
  }

  function showCursor() {
    document.body.classList.remove('hide-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(function () {
      document.body.classList.add('hide-cursor');
    }, 2500);
  }

  async function requestWakeLock() {
    if (preview || !('wakeLock' in navigator)) return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () {
        wakeLock = null;
      });
    } catch (e) {
      /* butuh HTTPS / gesture; diabaikan */
    }
  }

  if (!preview) {
    document.addEventListener('keydown', function (event) {
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        toggleFullscreen();
      }
    });
    document.addEventListener('dblclick', toggleFullscreen);
    document.addEventListener('mousemove', showCursor);
    document.addEventListener('pointerdown', requestWakeLock);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') requestWakeLock();
    });
    showCursor();
    requestWakeLock();
    if (!document.documentElement.requestFullscreen) {
      els.hint.textContent = 'Sembunyikan toolbar browser untuk mode layar penuh';
    }
    setTimeout(hideHint, 5000);
    setTimeout(hideHint, 7000);
  } else {
    els.hint.remove();
  }

  window.addEventListener('beforeunload', function () {
    conn.close();
  });
})();
