/* StageTimer — utilitas bersama untuk dashboard & layar panggung */
(function (global) {
  'use strict';

  var MAX_DURATION = 24 * 60 * 60 * 1000;

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function normalizeRoom(value) {
    var id = String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 40);
    return id || 'utama';
  }

  /** Format sisa waktu: 12:34, 1:02:03, -0:45 menjadi +0:45. */
  function formatTime(ms) {
    var totalSeconds = Math.ceil(ms / 1000);
    var sign = totalSeconds < 0 ? '+' : '';
    var abs = Math.abs(totalSeconds);
    var hours = Math.floor(abs / 3600);
    var minutes = Math.floor((abs % 3600) / 60);
    var seconds = abs % 60;
    if (hours > 0) return sign + hours + ':' + pad(minutes) + ':' + pad(seconds);
    return sign + pad(minutes) + ':' + pad(seconds);
  }

  /** Format jam dinding lokal: 14:05 */
  function formatClock(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  /** Format jam dinding dengan detik: 14:05:09 */
  function formatClockLong(date) {
    return formatClock(date) + ':' + pad(date.getSeconds());
  }

  function formatMinutes(minutes) {
    var m = Math.round(Number(minutes) || 0);
    if (m < 60) return m + ' mnt';
    var h = Math.floor(m / 60);
    var rest = m % 60;
    return rest ? h + ' j ' + rest + ' mnt' : h + ' jam';
  }

  function levelFor(remainingMs, settings) {
    var s = settings || {};
    if (remainingMs < 0) return 'over';
    if (remainingMs <= (Number(s.dangerAtMs) || 0)) return 'danger';
    if (remainingMs <= (Number(s.warnAtMs) || 0)) return 'warn';
    return 'ok';
  }

  /**
   * Parse input durasi: "15" = 15 menit, "15:30" = 15 mnt 30 dtk, "1:05:00" = 1 jam 5 mnt.
   * Mengembalikan milidetik, atau null jika tidak valid.
   */
  function parseDurationInput(text) {
    var raw = String(text == null ? '' : text).trim().replace(',', '.');
    if (!raw) return null;

    if (raw.indexOf(':') !== -1) {
      var parts = raw.split(':');
      if (parts.length < 2 || parts.length > 3) return null;
      var total = 0;
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i].trim();
        if (!/^\d+$/.test(part)) return null;
        total = total * 60 + Number(part);
      }
      if (total <= 0) return null;
      return Math.min(total * 1000, MAX_DURATION);
    }

    if (!/^\d+(\.\d+)?$/.test(raw)) return null;
    var minutes = Number(raw);
    if (!isFinite(minutes) || minutes <= 0) return null;
    return Math.min(Math.round(minutes * 60 * 1000), MAX_DURATION);
  }

  function durationInputValue(ms) {
    var totalSeconds = Math.round(ms / 1000);
    var h = Math.floor(totalSeconds / 3600);
    var m = Math.floor((totalSeconds % 3600) / 60);
    var s = totalSeconds % 60;
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
  }

  /**
   * Hubungkan ke state room.
   * - Server lokal memakai SSE (/api/stream).
   * - Server Cloudflare memakai WebSocket (/api/ws).
   * Transport dipilih otomatis dari /api/config.
   *
   * onState(state, serverNow, offset), onStatus('connecting'|'online'|'offline')
   */
  function connect(room, options) {
    var opts = options || {};
    var transport = null;
    var source = null;
    var socket = null;
    var offset = 0;
    var status = 'connecting';
    var lastEventAt = 0;
    var lastAttemptAt = 0;
    var watchdog = null;
    var reconnectTimer = null;
    var pingTimer = null;
    var retry = 0;
    var closed = false;

    function setStatus(next) {
      if (status === next) return;
      status = next;
      if (opts.onStatus) opts.onStatus(next);
    }

    function applyPayload(payload) {
      if (!payload || typeof payload !== 'object') return;

      if (payload.type === 'pong') {
        lastEventAt = Date.now();
        if (Number.isFinite(Number(payload.serverNow))) {
          offset = Number(payload.serverNow) - Date.now();
        }
        return;
      }

      if (!payload.state || !Number.isFinite(Number(payload.serverNow))) return;

      lastEventAt = Date.now();
      // ServerNow dikirim tiap event; selisih jam device dikoreksi di sini.
      offset = Number(payload.serverNow) - Date.now();
      setStatus('online');
      if (opts.onState) opts.onState(payload.state, Number(payload.serverNow), offset);
    }

    function teardown() {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopPing();

      if (socket) {
        var ws = socket;
        socket = null;
        try {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close();
        } catch (e) {
          /* diabaikan */
        }
      }

      if (source) {
        try {
          source.close();
        } catch (e) {
          /* diabaikan */
        }
        source = null;
      }
    }

    function startPing() {
      stopPing();
      pingTimer = setInterval(function () {
        if (closed || !socket || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {
          /* diabaikan */
        }
      }, 20000);
    }

    function stopPing() {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
    }

    function scheduleReconnect() {
      if (closed || reconnectTimer) return;
      var delay = Math.min(1200 * Math.pow(1.7, retry++), 15000);
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        attach();
      }, delay);
    }

    function attachSocket() {
      if (closed) return;
      if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;

      lastAttemptAt = Date.now();
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws;
      try {
        ws = new WebSocket(proto + '//' + location.host + '/api/ws?room=' + encodeURIComponent(room));
      } catch (e) {
        setStatus('offline');
        scheduleReconnect();
        return;
      }
      socket = ws;

      ws.onopen = function () {
        if (socket !== ws) return;
        lastEventAt = Date.now();
        retry = 0;
        setStatus('online');
        startPing();
      };

      ws.onmessage = function (event) {
        if (socket !== ws) return;
        var payload;
        try {
          payload = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        applyPayload(payload);
      };

      ws.onerror = function () {
        try {
          ws.close();
        } catch (e) {
          /* diabaikan */
        }
      };

      ws.onclose = function () {
        if (socket !== ws) return;
        socket = null;
        stopPing();
        setStatus('offline');
        scheduleReconnect();
      };
    }

    function attachEventSource() {
      if (closed) return;
      lastAttemptAt = Date.now();
      try {
        if (source) source.close();
      } catch (e) {
        /* diabaikan */
      }

      var es = new EventSource('/api/stream?room=' + encodeURIComponent(room));
      source = es;

      es.addEventListener('state', function (event) {
        if (source !== es) return;
        var payload;
        try {
          payload = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        applyPayload(payload);
      });

      es.addEventListener('ping', function (event) {
        if (source !== es) return;
        var payload;
        try {
          payload = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        applyPayload(payload);
      });

      es.onopen = function () {
        if (source !== es) return;
        lastEventAt = Date.now();
        retry = 0;
        setStatus('online');
      };

      es.onerror = function () {
        if (source !== es) return;
        setStatus('offline');
        // EventSource akan mencoba reconnect sendiri; watchdog menangani kasus macet.
      };
    }

    function attach() {
      if (closed) return;
      if (!transport) return;
      if (transport === 'ws') attachSocket();
      else attachEventSource();
    }

    function forceReconnect() {
      lastEventAt = Date.now();
      lastAttemptAt = Date.now();
      teardown();
      setStatus('connecting');
      attach();
    }

    fetch('/api/config', { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('config');
        return res.json();
      })
      .then(function (config) {
        transport = config && config.transport === 'ws' ? 'ws' : 'sse';
        attach();
      })
      .catch(function () {
        transport = 'sse';
        attach();
      });

    watchdog = setInterval(function () {
      if (closed || !transport) return;
      var stalled = status === 'online' && Date.now() - lastEventAt > 45000;
      var dead = status !== 'online' && Date.now() - lastAttemptAt > 15000;
      if (stalled || dead) forceReconnect();
    }, 10000);

    return {
      close: function () {
        closed = true;
        clearInterval(watchdog);
        teardown();
      },
      getOffset: function () {
        return offset;
      },
      serverNow: function () {
        return Date.now() + offset;
      },
      remainingOf: function (state) {
        if (!state) return 0;
        return state.running ? state.endsAt - (Date.now() + offset) : state.remainingMs;
      },
      status: function () {
        return status;
      },
      transport: function () {
        return transport;
      },
    };
  }

  async function sendAction(room, action) {
    var res = await fetch('/api/action?room=' + encodeURIComponent(room), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });

    var data = {};
    try {
      data = await res.json();
    } catch (e) {
      /* diabaikan */
    }

    if (res.status === 401) {
      var authError = new Error(data.error || 'Sesi berakhir. Silakan login lagi.');
      authError.code = 'UNAUTH';
      throw authError;
    }

    if (!res.ok) throw new Error(data.error || 'Perintah gagal dikirim.');
    return data;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(area);
      if (ok) resolve();
      else reject(new Error('Browser memblokir penyalinan. Salin manual dari kolom link.'));
    });
  }

  global.StageTimer = {
    MAX_DURATION: MAX_DURATION,
    normalizeRoom: normalizeRoom,
    formatTime: formatTime,
    formatClock: formatClock,
    formatClockLong: formatClockLong,
    formatMinutes: formatMinutes,
    levelFor: levelFor,
    parseDurationInput: parseDurationInput,
    durationInputValue: durationInputValue,
    connect: connect,
    sendAction: sendAction,
    copyText: copyText,
  };
})(window);
