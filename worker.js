/**
 * StageTimer — Cloudflare Workers edition
 *
 * - Durable Object "Room" menyimpan state & menyiarkan update lewat WebSocket.
 * - Dashboard dilindungi login (cookie sesi bertanda tangan HMAC).
 * - Layar panggung bersifat publik agar device di panggung tidak perlu login.
 *
 * Secrets yang dibutuhkan:
 *   ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET (opsional tapi disarankan)
 *
 * Login GitHub (opsional, untuk banyak akun):
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
 */

const DEFAULT_ROOM = 'utama';
const MAX_DURATION = 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'st_session';
const OAUTH_COOKIE = 'st_oauth';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

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
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
  return id || DEFAULT_ROOM;
}

function randomId(prefix = 'r') {
  return prefix + Math.random().toString(36).slice(2, 9);
}

function jsonResponse(data, status = 200, extraHeaders) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

async function serveAsset(env, request, assetPath) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  const asset = await env.ASSETS.fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: request.headers.get('Accept') || 'text/html' },
  });
  const headers = new Headers(asset.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  return new Response(asset.body, { status: asset.status, headers });
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

function getAuthConfig(env) {
  const email = String(env.ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();
  const password = String(env.ADMIN_PASSWORD || '');
  const secret =
    String(env.SESSION_SECRET || '') ||
    (password ? 'stage-timer-session:' + password : '');
  const githubId = String(env.GITHUB_CLIENT_ID || '').trim();
  const githubSecret = String(env.GITHUB_CLIENT_SECRET || '');
  const sessionSecret =
    secret || (githubSecret ? 'stage-timer-session:' + githubSecret : '');
  return {
    email,
    password,
    secret: sessionSecret,
    passwordConfigured: Boolean(email && password),
    githubId,
    githubSecret,
    githubConfigured: Boolean(githubId && githubSecret),
  };
}

function toBase64Url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(text) {
  let base64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(text, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return toBase64Url(signature);
}

async function digest(value) {
  const data = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toBase64Url(hash);
}

async function safeEqualText(a, b) {
  const [hashA, hashB] = await Promise.all([digest(a), digest(b)]);
  return timingSafeEqual(hashA, hashB);
}

async function createSessionToken(data, secret) {
  const payload = toBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ ...data, exp: Date.now() + SESSION_TTL_MS })
    )
  );
  const signature = await hmac(payload, secret);
  return payload + '.' + signature;
}

async function readSessionToken(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await hmac(payload, secret);
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!data || typeof data.sub !== 'string' || !data.sub) return null;
    if (!data.exp || Number(data.exp) < Date.now()) return null;

    const provider = data.provider === 'github' ? 'github' : 'admin';
    return {
      provider,
      uid: cleanText(data.uid, 40) || (provider === 'github' ? data.sub : 'admin'),
      email: provider === 'admin' ? data.sub : '',
      login: provider === 'github' ? data.sub : '',
      name: cleanText(data.name, 80),
      avatar: cleanText(data.avatar, 500),
      exp: Number(data.exp),
    };
  } catch {
    return null;
  }
}

function randomToken(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return toBase64Url(arr);
}

function githubRoomFor(session) {
  if (!session || session.provider !== 'github') return null;
  return 'u' + cleanRoomId(session.uid);
}

function canControlRoom(session, room) {
  if (!session) return false;
  if (session.provider === 'admin') return true;
  return room === githubRoomFor(session);
}

function safeNextPath(value) {
  const next = String(value == null ? '' : value).slice(0, 500);
  if (!next || next.charAt(0) !== '/') return '/';
  if (next.charAt(1) === '/' || next.indexOf('\\') !== -1) return '/';
  if (/^\/(login|login\.html)(\?|$)/i.test(next)) return '/';
  return next;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookie(token, secure) {
  return (
    SESSION_COOKIE +
    '=' +
    token +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    Math.floor(SESSION_TTL_MS / 1000) +
    (secure ? '; Secure' : '')
  );
}

function clearSessionCookie(secure) {
  return (
    SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '')
  );
}

function oauthStateCookie(value, secure) {
  return (
    OAUTH_COOKIE +
    '=' +
    value +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
    OAUTH_STATE_TTL_SECONDS +
    (secure ? '; Secure' : '')
  );
}

function clearOauthCookie(secure) {
  return (
    OAUTH_COOKIE +
    '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' +
    (secure ? '; Secure' : '')
  );
}

function redirectWithCookies(location, cookies) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
  });
  for (const cookie of cookies || []) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function isSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

async function exchangeGithubCode(code, auth, redirectUri) {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'StageTimer',
    },
    body: JSON.stringify({
      client_id: auth.githubId,
      client_secret: auth.githubSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) return null;

  let tokenData;
  try {
    tokenData = await tokenRes.json();
  } catch {
    return null;
  }
  const accessToken = tokenData && tokenData.access_token;
  if (!accessToken) return null;

  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'StageTimer',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!userRes.ok) return null;

  let user;
  try {
    user = await userRes.json();
  } catch {
    return null;
  }

  if (!user || !user.id || !user.login) return null;

  return {
    id: String(user.id),
    login: cleanText(user.login, 60),
    name: cleanText(user.name, 80),
    avatar: cleanText(user.avatar_url, 500),
  };
}

/* ------------------------------------------------------------------ */
/* State (sama dengan versi lokal)                                     */
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
    return { ...base, durationMs, remainingMs: Math.min(remainingMs, durationMs) };
  }

  let message = null;
  if (raw.message && cleanText(raw.message.text, 160)) {
    const until = raw.message.until == null ? null : Number(raw.message.until);
    if (until == null || until > Date.now()) {
      message = {
        text: cleanText(raw.message.text, 160),
        tone: ['info', 'warn', 'danger', 'success'].includes(raw.message.tone)
          ? raw.message.tone
          : 'info',
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

  const currentItemId = rundown.some((item) => item.id === raw.currentItemId)
    ? raw.currentItemId
    : null;

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
    state.message && (state.message.until == null || state.message.until > serverNow)
      ? state.message
      : null;

  return {
    room: room.roomId || DEFAULT_ROOM,
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
/* Durable Object: satu instance per ruang                             */
/* ------------------------------------------------------------------ */

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.roomId = DEFAULT_ROOM;
  }

  async ensureState() {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get('state');
    this.state = sanitizeState(stored);
    return this.state;
  }

  async save() {
    await this.ctx.storage.put('state', this.state);
  }

  async syncAlarm() {
    const message = this.state && this.state.message;
    if (message && message.until) {
      await this.ctx.storage.setAlarm(message.until + 100);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const roomParam = url.searchParams.get('room');
    if (roomParam) this.roomId = cleanRoomId(roomParam);

    await this.ensureState();

    try {
      if (url.pathname === '/api/ws') return this.handleSocket(request);

      if (url.pathname === '/api/state') {
        return jsonResponse(snapshot(this));
      }

      if (url.pathname === '/api/action') {
        if (request.method !== 'POST') {
          return jsonResponse({ ok: false, error: 'Gunakan POST.' }, 405);
        }
        let action;
        try {
          action = await request.json();
        } catch {
          throw new BadRequest('JSON tidak valid.');
        }
        const result = await this.applyAction(action);
        return jsonResponse({ ok: true, ...result });
      }

      return jsonResponse({ ok: false, error: 'Tidak ditemukan.' }, 404);
    } catch (err) {
      if (err instanceof BadRequest) {
        return jsonResponse({ ok: false, error: err.message }, 400);
      }
      console.error('[stage-timer] room error', err);
      return jsonResponse({ ok: false, error: 'Terjadi kesalahan di server.' }, 500);
    }
  }

  handleSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(snapshot(this)));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ensureState();
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', serverNow: Date.now() }));
    } else if (data.type === 'sync') {
      ws.send(JSON.stringify(snapshot(this)));
    }
  }

  broadcast() {
    const payload = JSON.stringify(snapshot(this));
    for (const client of this.ctx.getWebSockets()) {
      try {
        client.send(payload);
      } catch {
        /* diabaikan */
      }
    }
  }

  async alarm() {
    await this.ensureState();
    const message = this.state.message;

    if (message && message.until && message.until <= Date.now() + 100) {
      this.state.message = null;
      this.state.updatedAt = Date.now();
      await this.save();
      this.broadcast();
    }

    await this.syncAlarm();
  }

  async applyAction(action) {
    if (!action || typeof action !== 'object') throw new BadRequest('Aksi tidak valid.');

    const s = this.state;
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
          tone: ['info', 'warn', 'danger', 'success'].includes(action.tone)
            ? action.tone
            : 'info',
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
        if (action.minutes !== undefined)
          item.minutes = clampNumber(action.minutes, 1, 600, item.minutes);
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
    await this.save();
    await this.syncAlarm();
    this.broadcast();
    return snapshot(this);
  }
}

/* ------------------------------------------------------------------ */
/* Durable Object: daftar ruang                                        */
/* ------------------------------------------------------------------ */

const MAX_REGISTERED_ROOMS = 300;

export class Registry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rooms = null;
  }

  async ensureState() {
    if (this.rooms) return this.rooms;
    const stored = await this.ctx.storage.get('rooms');
    this.rooms = stored && typeof stored === 'object' ? stored : {};
    return this.rooms;
  }

  async save() {
    await this.ctx.storage.put('rooms', this.rooms);
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureState();

    if (url.pathname === '/register') {
      if (request.method !== 'POST') {
        return jsonResponse({ ok: false, error: 'Gunakan POST.' }, 405);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'JSON tidak valid.' }, 400);
      }

      const id = cleanRoomId(body && body.room);
      const label = cleanText(body && body.label, 160);
      const existing = this.rooms[id];
      const now = Date.now();

      this.rooms[id] = {
        id,
        label: label || (existing && existing.label) || '',
        updatedAt: now,
      };

      const ordered = Object.values(this.rooms).sort((a, b) => b.updatedAt - a.updatedAt);
      this.rooms = Object.fromEntries(
        ordered.slice(0, MAX_REGISTERED_ROOMS).map((room) => [room.id, room])
      );
      await this.save();

      return jsonResponse({ ok: true, room: this.rooms[id] });
    }

    if (url.pathname === '/list') {
      const rooms = Object.values(this.rooms).sort((a, b) => b.updatedAt - a.updatedAt);
      return jsonResponse({ ok: true, rooms });
    }

    return jsonResponse({ ok: false, error: 'Tidak ditemukan.' }, 404);
  }
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

function isDashboardPath(path) {
  return (
    path === '/' ||
    path === '/index.html' ||
    path === '/dashboard' ||
    path === '/dashboard/' ||
    path === '/operator' ||
    path === '/operator/'
  );
}

function isDisplayPath(path) {
  return (
    path === '/display' ||
    path === '/display/' ||
    path === '/display.html' ||
    path === '/output' ||
    path === '/output/' ||
    path === '/stage' ||
    path === '/stage/'
  );
}

function roomStub(env, room) {
  const id = env.ROOMS.idFromName(room);
  return env.ROOMS.get(id);
}

function registryStub(env) {
  const id = env.REGISTRY.idFromName('global');
  return env.REGISTRY.get(id);
}

async function registerRoom(env, room, label) {
  if (!env.REGISTRY) return;
  try {
    await registryStub(env).fetch('https://registry.internal/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room, label: label || '' }),
    });
  } catch {
    /* pendaftaran ruang tidak boleh menggagalkan aksi utama */
  }
}

async function listRegisteredRooms(env) {
  if (!env.REGISTRY) return [];
  try {
    const res = await registryStub(env).fetch('https://registry.internal/list');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.rooms) ? data.rooms : [];
  } catch {
    return [];
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const auth = getAuthConfig(env);

    /* Konfigurasi publik untuk frontend ------------------------------ */
    if (path === '/api/config') {
      return jsonResponse({
        transport: 'ws',
        online: true,
        authConfigured: auth.passwordConfigured,
        githubAuth: auth.githubConfigured,
      });
    }

    if (path === '/api/info') {
      return jsonResponse({ online: true, lanAddresses: [], port: null });
    }

    /* Login GitHub ---------------------------------------------------- */
    if (path === '/api/auth/github') {
      if (method !== 'GET') return jsonResponse({ ok: false, error: 'Gunakan GET.' }, 405);
      const secure = url.protocol === 'https:';
      if (!auth.githubConfigured) {
        return redirectWithCookies('/login?error=github_unconfigured', [
          clearOauthCookie(secure),
        ]);
      }

      const next = safeNextPath(url.searchParams.get('next'));
      const state = randomToken(18);
      const callbackUrl = url.origin + '/api/auth/github/callback';
      const authorize = new URL('https://github.com/login/oauth/authorize');
      authorize.searchParams.set('client_id', auth.githubId);
      authorize.searchParams.set('redirect_uri', callbackUrl);
      authorize.searchParams.set('scope', 'read:user');
      authorize.searchParams.set('state', state);

      return redirectWithCookies(authorize.toString(), [
        oauthStateCookie(state + '|' + encodeURIComponent(next), secure),
      ]);
    }

    if (path === '/api/auth/github/callback') {
      if (method !== 'GET') return jsonResponse({ ok: false, error: 'Gunakan GET.' }, 405);
      const secure = url.protocol === 'https:';
      const fail = (code) =>
        redirectWithCookies('/login?error=' + code, [clearOauthCookie(secure)]);

      if (!auth.githubConfigured) return fail('github_unconfigured');

      const rawCookie = getCookie(request, OAUTH_COOKIE) || '';
      const separator = rawCookie.indexOf('|');
      const expectedState = separator === -1 ? rawCookie : rawCookie.slice(0, separator);

      let next = '/';
      if (separator !== -1) {
        try {
          next = safeNextPath(decodeURIComponent(rawCookie.slice(separator + 1)));
        } catch {
          next = '/';
        }
      }

      const state = url.searchParams.get('state') || '';
      if (!expectedState || !timingSafeEqual(state, expectedState)) {
        return fail('github_state');
      }
      if (url.searchParams.get('error')) return fail('github_denied');

      const code = url.searchParams.get('code') || '';
      if (!code) return fail('github_failed');

      let githubUser = null;
      try {
        githubUser = await exchangeGithubCode(
          code,
          auth,
          url.origin + '/api/auth/github/callback'
        );
      } catch {
        githubUser = null;
      }

      if (!githubUser || !auth.secret) return fail('github_failed');

      const token = await createSessionToken(
        {
          sub: githubUser.login,
          uid: githubUser.id,
          provider: 'github',
          name: githubUser.name,
          avatar: githubUser.avatar,
        },
        auth.secret
      );

      return redirectWithCookies(next, [
        sessionCookie(token, secure),
        clearOauthCookie(secure),
      ]);
    }

    /* Login / logout -------------------------------------------------- */
    if (path === '/api/login') {
      if (method !== 'POST') return jsonResponse({ ok: false, error: 'Gunakan POST.' }, 405);
      if (!isSameOrigin(request)) return jsonResponse({ ok: false, error: 'Origin tidak valid.' }, 403);

      if (!auth.passwordConfigured) {
        return jsonResponse(
          {
            ok: false,
            error:
              'Login password belum diatur. Set secrets ADMIN_EMAIL dan ADMIN_PASSWORD lewat Wrangler, atau masuk dengan GitHub.',
          },
          503
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'Format login tidak valid.' }, 400);
      }

      const email = String(body.email || '')
        .trim()
        .toLowerCase();
      const password = String(body.password || '');

      const [emailOk, passwordOk] = await Promise.all([
        safeEqualText(email, auth.email),
        safeEqualText(password, auth.password),
      ]);

      if (!emailOk || !passwordOk) {
        return jsonResponse({ ok: false, error: 'Email atau password salah.' }, 401);
      }

      const token = await createSessionToken(
        { sub: auth.email, uid: 'admin', provider: 'admin' },
        auth.secret
      );
      const secure = url.protocol === 'https:';
      return jsonResponse(
        { ok: true, email: auth.email },
        200,
        { 'Set-Cookie': sessionCookie(token, secure) }
      );
    }

    if (path === '/api/logout') {
      if (method !== 'POST') return jsonResponse({ ok: false, error: 'Gunakan POST.' }, 405);
      const secure = url.protocol === 'https:';
      return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(secure) });
    }

    /* Sesi ------------------------------------------------------------ */
    const session = await readSessionToken(
      getCookie(request, SESSION_COOKIE),
      auth.secret
    );

    if (path === '/api/me') {
      if (!session) return jsonResponse({ ok: false, error: 'Belum login.' }, 401);
      return jsonResponse({
        ok: true,
        provider: session.provider,
        email: session.email,
        login: session.login,
        name: session.name,
        avatar: session.avatar,
        room: githubRoomFor(session),
        exp: session.exp,
      });
    }

    /* API ruang ------------------------------------------------------- */
    if (path === '/api/rooms') {
      if (method !== 'GET') return jsonResponse({ ok: false, error: 'Gunakan GET.' }, 405);
      if (!session) return jsonResponse({ ok: false, error: 'Belum login.' }, 401);

      let rooms = await listRegisteredRooms(env);
      const ownRoom = githubRoomFor(session);

      if (ownRoom) {
        rooms = rooms.filter((item) => item.id === ownRoom);
        if (!rooms.length) rooms = [{ id: ownRoom, label: '', updatedAt: Date.now() }];
      } else if (!rooms.some((item) => item.id === DEFAULT_ROOM)) {
        rooms.push({ id: DEFAULT_ROOM, label: '', updatedAt: 0 });
      }

      return jsonResponse({ ok: true, rooms });
    }

    if (path === '/api/rooms/touch') {
      if (method !== 'POST') return jsonResponse({ ok: false, error: 'Gunakan POST.' }, 405);
      if (!session) return jsonResponse({ ok: false, error: 'Belum login.' }, 401);
      if (!isSameOrigin(request)) {
        return jsonResponse({ ok: false, error: 'Origin tidak valid.' }, 403);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        body = {};
      }

      const room = cleanRoomId(body && body.room);
      if (!canControlRoom(session, room)) {
        return jsonResponse(
          { ok: false, error: 'Kamu hanya bisa mengatur ruang akunmu sendiri.' },
          403
        );
      }

      await registerRoom(env, room, cleanText(body && body.label, 160));
      return jsonResponse({ ok: true, room });
    }

    if (path === '/api/state') {
      const room = cleanRoomId(url.searchParams.get('room'));
      return roomStub(env, room).fetch(request);
    }

    if (path === '/api/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const room = cleanRoomId(url.searchParams.get('room'));
      return roomStub(env, room).fetch(request);
    }

    if (path === '/api/action') {
      if (method !== 'POST') return jsonResponse({ ok: false, error: 'Gunakan POST.' }, 405);
      if (!session) {
        return jsonResponse(
          { ok: false, error: 'Sesi berakhir. Silakan login lagi.' },
          401
        );
      }
      if (!isSameOrigin(request)) {
        return jsonResponse({ ok: false, error: 'Origin tidak valid.' }, 403);
      }
      const room = cleanRoomId(url.searchParams.get('room'));
      if (!canControlRoom(session, room)) {
        return jsonResponse(
          { ok: false, error: 'Kamu hanya bisa mengatur ruang akunmu sendiri.' },
          403
        );
      }
      if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(registerRoom(env, room, ''));
      }
      return roomStub(env, room).fetch(request);
    }

    if (path.startsWith('/api/')) {
      return jsonResponse({ ok: false, error: 'Endpoint tidak ditemukan.' }, 404);
    }

    /* Halaman --------------------------------------------------------- */
    if (isDashboardPath(path)) {
      if (!session) {
        const next = path === '/' ? '/' : path + url.search;
        return redirect('/login?next=' + encodeURIComponent(next));
      }

      const ownRoom = githubRoomFor(session);
      if (ownRoom) {
        const requestedRoom = cleanRoomId(url.searchParams.get('room'));
        if (requestedRoom !== ownRoom) {
          return redirect('/?room=' + encodeURIComponent(ownRoom));
        }
      }

      return serveAsset(env, request, '/index.html');
    }

    if (path === '/login' || path === '/login.html') {
      if (session) {
        const ownRoom = githubRoomFor(session);
        return redirect(ownRoom ? '/?room=' + encodeURIComponent(ownRoom) : '/');
      }
      return serveAsset(env, request, '/login.html');
    }

    if (isDisplayPath(path)) {
      return serveAsset(env, request, '/display.html');
    }

    /* Asset statis ---------------------------------------------------- */
    return env.ASSETS.fetch(request);
  },
};
