'use strict';

/**
 * StageTimer — server sinkronisasi timer panggung.
 * Tanpa dependency eksternal: cukup `node server.js`.
 *
 * Arsitektur:
 *  - Dashboard operator mengirim aksi (start/pause/reset/...) lewat POST /api/action
 *  - Server adalah sumber kebenaran waktu (endsAt), semua layar menghitung sisa waktu
 *    dari jam server sehingga tidak ada drift antar device.
 *  - Layar panggung berlangganan SSE /api/stream dan langsung menerima state terbaru.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

const DEFAULT_ROOM = 'utama';
const MAX_BODY = 64 * 1024;
const TICK_MS = 10_000;
const MAX_DURATION = 24 * 60 * 60 * 1000;
const ROOM_ID_RE = /[^a-z0-9_-]/g;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class BadRequest extends Error {}

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

function cleanText(value, max = 160) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanRoomId(value) {
  const id = String(value == null ? '' : value)
    .toLowerCase()
    .replace(ROOM_ID_RE, '')
    .slice(0, 40);
  return id || DEFAULT_ROOM;
}

function randomId(prefix = 'r') {
  return prefix + Math.random().toString(36).slice(2, 9);
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

function defaultSettings() {
  return {
    warnAtMs: 5 * 60 * 1000,
    dangerAtMs: 60 * 1000,
    showClock: true,
    showProgress: true,
    showNext: true,
    showStatus: true,
    showSublabel: true,
    blink: true,
    theme: 'dark',
  };
}

function defaultState() {
  return {
    label: 'Pembicara',
    sublabel: '',
    running: false,
    durationMs: 15 * 60 * 1000,
    remainingMs: 15 * 60 * 1000,
    endsAt: null,
    startedAt: null,
    message: null,
    settings: defaultSettings(),
    rundown: [],
    currentItemId: null,
    updatedAt: Date.now(),
  };
}

function sanitizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    warnAtMs: clampNumber(raw.warnAtMs, 0, MAX_DURATION, base.warnAtMs),
    dangerAtMs: clampNumber(raw.dangerAtMs, 0, MAX_DURATION, base.dangerAtMs),
    showClock: raw.showClock !== false,
    showProgress: raw.showProgress !== false,
    showNext: raw.showNext !== false,
    showStatus: raw.showStatus !== false,
    showSublabel: raw.showSublabel !== false,
    blink: raw.blink !== false,
    theme: raw.theme === 'light' ? 'light' : 'dark',
  };
}

function sanitizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;

  const durationMs = clampNumber(raw.durationMs, 1000, MAX_DURATION, base.durationMs);
  let remainingMs = clampNumber(raw.remainingMs, -MAX_DURATION, MAX_DURATION, durationMs);
  const running = raw.running === true;
  const endsAt = running ? clampNumber(raw.endsAt, 0, Date.now() + MAX_DURATION * 2, null) : null;

  if (running && !endsAt) {
    // State rusak: jangan biarkan timer "berjalan" tanpa titik akhir.
    return { ...base, durationMs, remainingMs: Math.min(remainingMs, durationMs) };
  }

  let message = null;
  if (raw.message && cleanText(raw.message.text, 160)) {
    const until = raw.message.until == null ? null : Number(raw.message.until);
    if (until == null || until > Date.now()) {
      message = {
        text: cleanText(raw.message.text, 160),
        tone: ['info', 'warn', 'danger', 'success'].includes(raw.message.tone) ? raw.message.tone : 'info',
        since: Number(raw.message.since) || Date.now(),
        until: until == null ? null : until,
      };
    }
  }

  const rundown = Array.isArray(raw.rundown)
    ? raw.rundown
        .filter((item) => item && cleanText(item.title, 160))
        .map((item) => ({
          id: cleanText(item.id, 40) || randomId(),
          title: cleanText(item.title, 160),
          speaker: cleanText(item.speaker, 120),
          minutes: clampNumber(item.minutes, 1, 600, 15),
        }))
        .slice(0, 200)
    : [];

  const currentItemId = rundown.some((item) => item.id === raw.currentItemId) ? raw.currentItemId : null;

  return {
    label: cleanText(raw.label, 160),
    sublabel: cleanText(raw.sublabel, 160),
    running,
    durationMs,
    remainingMs,
    endsAt,
    startedAt: Number(raw.startedAt) || null,
    message,
    settings: sanitizeSettings(raw.settings),
    rundown,
    currentItemId,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function snapshot(room) {
  const serverNow = Date.now();
  const state = room.state;
  const remainingMs = state.running ? state.endsAt - serverNow : state.remainingMs;
  const message =
    state.message && (state.message.until == null || state.message.until > serverNow) ? state.message : null;

  return {
    room: room.id,
    serverNow,
    state: {
      ...state,
      remainingMs,
      message,
      settings: { ...state.settings },
      rundown: state.rundown.map((item) => ({ ...item })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function makeRoom(id, state) {
  return {
    id,
    state: state || defaultState(),
    clients: new Set(),
    saveTimer: null,
    messageTimer: null,
  };
}

function getRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = makeRoom(id);
    rooms.set(id, room);
  }
  return room;
}

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [id, state] of Object.entries(raw)) {
      const roomId = cleanRoomId(id);
      rooms.set(roomId, makeRoom(roomId, sanitizeState(state)));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[stage-timer] gagal memuat state:', err.message);
  }
  for (const room of rooms.values()) scheduleMessageClear(room);
}

function scheduleSave(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => saveAll(), 400);
}

function saveAll() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = {};
    for (const [id, room] of rooms) {
      const { state } = room;
      data[id] = {
        label: state.label,
        sublabel: state.sublabel,
        running: state.running,
        durationMs: state.durationMs,
        remainingMs: state.remainingMs,
        endsAt: state.endsAt,
        startedAt: state.startedAt,
        message: state.message,
        settings: state.settings,
        rundown: state.rundown,
        currentItemId: state.currentItemId,
        updatedAt: state.updatedAt,
      };
    }
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.warn('[stage-timer] gagal menyimpan state:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

function sseSend(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function broadcast(room) {
  if (room.clients.size === 0) return;
  const payload = JSON.stringify(snapshot(room));
  for (const res of room.clients) {
    try {
      res.write('event: state\ndata: ' + payload + '\n\n');
    } catch {
      room.clients.delete(res);
    }
  }
}

function scheduleMessageClear(room) {
  clearTimeout(room.messageTimer);
  room.messageTimer = null;
  const message = room.state.message;
  if (!message || message.until == null) return;

  const delay = Math.max(0, message.until - Date.now());
  room.messageTimer = setTimeout(() => {
    const current = room.state.message;
    if (!current || current.until == null) return;
    if (current.until > Date.now() + 50) return;
    room.state.message = null;
    room.state.updatedAt = Date.now();
    broadcast(room);
    scheduleSave(room);
  }, delay + 30);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function applyAction(room, action) {
  if (!action || typeof action !== 'object') throw new BadRequest('Aksi tidak valid.');

  const s = room.state;
  const t = Date.now();
  const type = String(action.type || '');

  switch (type) {
    case 'start': {
      if (s.running) break;
      if (s.remainingMs <= 0) s.remainingMs = s.durationMs;
      s.remainingMs = Math.min(s.remainingMs, s.durationMs);
      s.running = true;
      s.endsAt = t + s.remainingMs;
      s.startedAt = t;
      break;
    }

    case 'pause': {
      if (!s.running) break;
      s.remainingMs = s.endsAt - t;
      s.running = false;
      s.endsAt = null;
      break;
    }

    case 'reset': {
      s.running = false;
      s.endsAt = null;
      s.remainingMs = s.durationMs;
      break;
    }

    case 'restart': {
      s.durationMs = clampNumber(action.ms, 1000, MAX_DURATION, s.durationMs);
      s.remainingMs = s.durationMs;
      s.running = true;
      s.endsAt = t + s.durationMs;
      s.startedAt = t;
      break;
    }

    case 'addMs': {
      const delta = clampNumber(action.ms, -6 * 60 * 60 * 1000, 6 * 60 * 60 * 1000, 0);
      if (!delta) break;
      s.durationMs = clamp(s.durationMs + delta, 1000, MAX_DURATION);
      if (s.running) s.endsAt += delta;
      else s.remainingMs += delta;
      break;
    }

    case 'setDurationMs': {
      const ms = clampNumber(action.ms, 1000, MAX_DURATION, null);
      if (ms == null) throw new BadRequest('Durasi tidak valid.');
      s.durationMs = ms;
      s.remainingMs = ms;
      s.running = false;
      s.endsAt = null;
      break;
    }

    case 'setMeta': {
      if (action.label !== undefined) s.label = cleanText(action.label, 160);
      if (action.sublabel !== undefined) s.sublabel = cleanText(action.sublabel, 160);
      break;
    }

    case 'setSettings': {
      s.settings = sanitizeSettings({ ...s.settings, ...(action.settings || {}) });
      break;
    }

    case 'message': {
      const text = cleanText(action.text, 160);
      if (!text) {
        s.message = null;
        break;
      }
      const ttl = clampNumber(action.ttlMs, 0, 60 * 60 * 1000, 30 * 1000);
      s.message = {
        text,
        tone: ['info', 'warn', 'danger', 'success'].includes(action.tone) ? action.tone : 'info',
        since: t,
        until: ttl > 0 ? t + ttl : null,
      };
      break;
    }

    case 'clearMessage': {
      s.message = null;
      break;
    }

    case 'rundown:add': {
      const title = cleanText(action.title, 160);
      if (!title) throw new BadRequest('Judul sesi wajib diisi.');
      if (s.rundown.length >= 200) throw new BadRequest('Rundown sudah terlalu panjang.');
      s.rundown.push({
        id: randomId(),
        title,
        speaker: cleanText(action.speaker, 120),
        minutes: clampNumber(action.minutes, 1, 600, 15),
      });
      break;
    }

    case 'rundown:update': {
      const item = s.rundown.find((it) => it.id === action.id);
      if (!item) throw new BadRequest('Sesi tidak ditemukan.');
      if (action.title !== undefined) item.title = cleanText(action.title, 160) || item.title;
      if (action.speaker !== undefined) item.speaker = cleanText(action.speaker, 120);
      if (action.minutes !== undefined) item.minutes = clampNumber(action.minutes, 1, 600, item.minutes);
      break;
    }

    case 'rundown:remove': {
      s.rundown = s.rundown.filter((it) => it.id !== action.id);
      if (s.currentItemId === action.id) s.currentItemId = null;
      break;
    }

    case 'rundown:move': {
      const index = s.rundown.findIndex((it) => it.id === action.id);
      if (index < 0) break;
      const dir = action.dir === 'up' ? -1 : 1;
      const next = index + dir;
      if (next < 0 || next >= s.rundown.length) break;
      const [item] = s.rundown.splice(index, 1);
      s.rundown.splice(next, 0, item);
      break;
    }

    case 'rundown:clear': {
      s.rundown = [];
      s.currentItemId = null;
      break;
    }

    case 'loadItem': {
      const item = s.rundown.find((it) => it.id === action.id);
      if (!item) throw new BadRequest('Sesi tidak ditemukan.');
      s.currentItemId = item.id;
      s.label = item.title;
      s.sublabel = item.speaker;
      s.durationMs = item.minutes * 60 * 1000;
      s.remainingMs = s.durationMs;
      s.running = false;
      s.endsAt = null;
      s.message = null;
      break;
    }

    default:
      throw new BadRequest('Aksi tidak dikenal: ' + type);
  }

  s.updatedAt = t;
  scheduleMessageClear(room);
  broadcast(room);
  scheduleSave(room);
  return snapshot(room);
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BadRequest('Payload terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequest('JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/display' || rel === '/display/' || rel === '/output' || rel === '/output/' || rel === '/stage' || rel === '/stage/') {
    rel = '/display.html';
  }
  if (rel === '/dashboard' || rel === '/dashboard/' || rel === '/operator' || rel === '/operator/') {
    rel = '/index.html';
  }
  if (rel === '/login' || rel === '/login.html') {
    rel = '/index.html';
  }

  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Tidak ditemukan');
    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': stat.size,
    };
    res.writeHead(200, headers);
    fs.createReadStream(filePath)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch {
    return sendText(res, 400, 'Bad request');
  }

  const pathname = url.pathname;
  const roomId = cleanRoomId(url.searchParams.get('room'));

  try {
    if (pathname === '/api/stream') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      const room = getRoom(roomId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');

      room.clients.add(res);
      sseSend(res, 'state', snapshot(room));

      const ping = setInterval(() => {
        try {
          sseSend(res, 'ping', { serverNow: Date.now() });
        } catch {
          /* diabaikan */
        }
      }, 20_000);

      req.on('close', () => {
        clearInterval(ping);
        room.clients.delete(res);
      });
      return;
    }

    if (pathname === '/api/info') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      return sendJson(res, 200, {
        port: PORT,
        lanAddresses: lanAddresses(),
        defaultRoom: DEFAULT_ROOM,
      });
    }

    if (pathname === '/api/config') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      return sendJson(res, 200, {
        transport: 'sse',
        online: false,
        authConfigured: false,
      });
    }

    if (pathname === '/api/state') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      return sendJson(res, 200, snapshot(getRoom(roomId)));
    }

    if (pathname === '/api/rooms') {
      if (req.method !== 'GET') return sendText(res, 405, 'Method not allowed');
      const list = [...rooms.values()]
        .map((item) => ({
          id: item.id,
          label: item.state.label || '',
          updatedAt: item.state.updatedAt || 0,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return sendJson(res, 200, { ok: true, rooms: list });
    }

    if (pathname === '/api/rooms/touch') {
      if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed');
      const body = await readJson(req);
      const target = cleanRoomId(body && body.room);
      getRoom(target);
      return sendJson(res, 200, { ok: true, room: target });
    }

    if (pathname === '/api/action') {
      if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed');
      const body = await readJson(req);
      const result = applyAction(getRoom(roomId), body);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (pathname === '/healthz') {
      return sendText(res, 200, 'ok');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed');
    }

    return serveStatic(res, pathname);
  } catch (err) {
    if (err instanceof BadRequest) return sendJson(res, 400, { ok: false, error: err.message });
    console.error('[stage-timer]', err);
    return sendJson(res, 500, { ok: false, error: 'Terjadi kesalahan di server.' });
  }
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.clients.size > 0) broadcast(room);
  }
}, TICK_MS);

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function shutdown() {
  console.log('\n[stage-timer] menyimpan state dan berhenti...');
  for (const room of rooms.values()) clearTimeout(room.messageTimer);
  saveAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loadRooms();

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  Port ' + PORT + ' sudah dipakai aplikasi lain.');
    console.error('  Coba jalankan:  start.bat ' + (PORT + 1));
    console.error('  lalu buka http://localhost:' + (PORT + 1));
    console.error('');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const addresses = lanAddresses();
  console.log('');
  console.log('  StageTimer siap dipakai');
  console.log('  ----------------------');
  console.log('  Dashboard operator : http://localhost:' + PORT + '/');
  console.log('  Layar panggung     : http://localhost:' + PORT + '/display');
  if (addresses.length) {
    console.log('');
    console.log('  Dari device lain (satu jaringan):');
    for (const ip of addresses) {
      console.log('  Dashboard : http://' + ip + ':' + PORT + '/');
      console.log('  Layar     : http://' + ip + ':' + PORT + '/display');
    }
  } else {
    console.log('\n  Tidak ada IP LAN terdeteksi. Cek koneksi WiFi/LAN.');
  }
  console.log('');
  console.log('  Tekan Ctrl+C untuk berhenti.');
  console.log('');
});
