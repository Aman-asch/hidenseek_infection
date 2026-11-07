'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// Generate PWA icons on first boot if they are missing (no binary files in git).
require('./tools/make-icons').ensureIcons();

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;

const GRACE_MS = 2 * 60 * 1000;          // reconnect grace period (spec: 2 min)
const KEEPALIVE_MS = 4 * 60 * 1000;      // heartbeat every 4 min (Render idles at 15 min)
const MAX_PLAYERS = 999;                 // 3-digit codes => 000..999
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const ROOM_CODE_LENGTH = 4;

const ROUND_MIN = 5;
const ROUND_MAX = 60;
const ROUND_DEFAULT = 15;

const PING_MIN = 10;
const PING_MAX = 120;
const PING_DEFAULT = 30;

const GATHER_MS = 5 * 1000;              // everyone shares one map and stands in a circle
const PLAY_RADIUS_M = 1000;              // fixed circle, it does not shrink
const SEEKER_WAIT_MIN = 0;
const SEEKER_WAIT_MAX = 180;
const SEEKER_WAIT_DEFAULT = 30;
const GATHER_PING_MS = 1000;
const CHAT_MAX = 200;
const CHAT_HISTORY = 40;
const CHAT_GAP_MS = 400;

const TICK_MS = 500;                     // internal tick (cheap, no I/O)
const TIME_BROADCAST_MS = 1000;

// Two-tier GPS filter. Movement keeps anything a phone can reasonably produce.
// Pings prefer a tighter subset so Wi-Fi/IP geolocation (often 50–500 m off on
// desktop Chrome) is not drawn as if it were a GPS point. If nothing meets the
// ping bar, the broadcast is the best fix we have and is marked stale.
const TRACK_MAX_ACCURACY_M = 50;
const PING_MAX_ACCURACY_M = 25;
const SMOOTH_WINDOW_MS = 10 * 1000;
const STALE_MAX_AGE_MS = 60 * 1000;
const FIX_BUFFER_MAX = 60;

// A tag lands if the smoothed positions are within 15 m, or if the reported
// uncertainty circles still overlap after each radius is capped. The cap stops
// a ±150 m desktop fix from authorizing a tag from across campus.
const TAG_DISTANCE_M = 15;
const TAG_RADIUS_CAP_M = 30;
const TAG_ABS_MAX_M = 40;

// A fix that jumps farther than a person can move is kept in the raw buffer
// but left out of the median. 80 m in a few seconds is a GPS spike, not a sprint.
const TELEPORT_MIN_M = 80;
const TELEPORT_MAX_MPS = 12;

/* ------------------------------------------------------------------ */
/* State (in-memory only, discarded when the room ends)                */
/* ------------------------------------------------------------------ */

/** @type {Map<string, Room>} */
const rooms = new Map();

/* ------------------------------------------------------------------ */
/* HTTP + Socket.IO                                                    */
/* ------------------------------------------------------------------ */

const app = express();

app.set('trust proxy', 1);

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
      if (filePath.endsWith('manifest.json')) {
        res.setHeader('Content-Type', 'application/manifest+json');
      }
    },
  })
);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    rooms: rooms.size,
    players: [...rooms.values()].reduce((n, r) => n + r.players.size, 0),
    serverTime: Date.now(),
  });
});

// Tiny endpoint the client pings before opening the socket so Render can
// start warming up while the "Connecting…" overlay is showing.
app.get('/wake', (_req, res) => res.type('text/plain').send('awake'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5,
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normNickname(raw) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 20);
  return s;
}

function normSessionId(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, 64);
}

function normBoundary(raw) {
  return raw === 'none' ? 'none' : 'circle';
}

function readSettings(payload, prev) {
  const previous = prev || {};
  const noLimit = !!payload.noLimit;
  return {
    roundMinutes: noLimit
      ? null
      : clampInt(payload.roundMinutes, ROUND_MIN, ROUND_MAX, previous.roundMinutes ?? ROUND_DEFAULT),
    pingInterval: clampInt(
      payload.pingInterval,
      PING_MIN,
      PING_MAX,
      previous.pingInterval ?? PING_DEFAULT
    ),
    seekerWait: clampInt(
      payload.seekerWait,
      SEEKER_WAIT_MIN,
      SEEKER_WAIT_MAX,
      previous.seekerWait ?? SEEKER_WAIT_DEFAULT
    ),
    boundary: normBoundary(payload.boundary != null ? payload.boundary : previous.boundary),
  };
}

function normChat(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, CHAT_MAX);
}

function getRoom(code) {
  if (!code) return null;
  return rooms.get(String(code).trim().toUpperCase()) || null;
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  // Extremely unlikely; append a random suffix to break the loop.
  return ('R' + Date.now().toString(36).toUpperCase()).slice(0, ROOM_CODE_LENGTH + 2);
}

function makeCodePool() {
  const pool = [];
  for (let i = 0; i < 1000; i++) pool.push(String(i).padStart(3, '0'));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function socketFor(player) {
  if (!player || !player.socketId) return null;
  return io.sockets.sockets.get(player.socketId) || null;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function medianNum(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function usableAccuracy(accuracy) {
  return Number.isFinite(accuracy) && accuracy >= 0;
}

function isGoodFix(fix) {
  return usableAccuracy(fix.accuracy) && fix.accuracy <= PING_MAX_ACCURACY_M && !fix.teleport;
}

function isTrackFix(fix) {
  return usableAccuracy(fix.accuracy) && fix.accuracy <= TRACK_MAX_ACCURACY_M && !fix.teleport;
}

/** True when this fix could not have been reached on foot from the last tracked one. */
function looksLikeTeleport(player, fix) {
  const prev = player.lastTrackedFix;
  if (!prev) return false;
  const dt = (fix.ts - prev.ts) / 1000;
  if (!(dt > 0 && dt <= 30)) return false;
  const dist = haversineM(prev.lat, prev.lng, fix.lat, fix.lng);
  if (dist < TELEPORT_MIN_M) return false;
  return dist / dt > TELEPORT_MAX_MPS;
}

/** Drop fixes that have aged out of the smoothing window. */
function pruneFixes(player, now) {
  const cutoff = now - SMOOTH_WINDOW_MS;
  if (player.fixes.length > FIX_BUFFER_MAX) {
    player.fixes.splice(0, player.fixes.length - FIX_BUFFER_MAX);
  }
  let drop = 0;
  while (drop < player.fixes.length && player.fixes[drop].ts < cutoff) drop++;
  if (drop > 0) player.fixes.splice(0, drop);
  return player.fixes;
}

function positionFromFixes(fixes, stale) {
  return {
    lat: medianNum(fixes.map((f) => f.lat)),
    lng: medianNum(fixes.map((f) => f.lng)),
    accuracy: medianNum(fixes.map((f) => f.accuracy)),
    ts: fixes.reduce((max, f) => Math.max(max, f.ts), 0),
    stale: !!stale,
    samples: fixes.length,
  };
}

function rememberGood(player, pos) {
  if (!pos || !usableAccuracy(pos.accuracy)) return;
  if (pos.accuracy > TRACK_MAX_ACCURACY_M) return;
  player.lastGood = pos;
}

/**
 * Median of the last 10s of fixes that are good enough to track (≤ 50 m).
 * Used for tag distance so one jumped point cannot make or break a tag.
 */
function trackingPosition(player, now) {
  const window = pruneFixes(player, now);
  const track = window.filter(isTrackFix);
  if (track.length) {
    const pos = positionFromFixes(track, false);
    rememberGood(player, pos);
    return pos;
  }
  const prev = player.lastGood;
  if (prev && now - prev.ts <= STALE_MAX_AGE_MS) {
    return { ...prev, stale: true };
  }
  return null;
}

/**
 * Position broadcast on a ping. Prefers a median of ≤ 25 m fixes. Falls back
 * to the track-quality median, then to the single tightest raw fix, then to
 * the last good position if it is less than a minute old. Fallbacks are stale.
 */
function pingPosition(player, now) {
  const window = pruneFixes(player, now);
  const good = window.filter(isGoodFix);
  if (good.length) {
    const pos = positionFromFixes(good, false);
    rememberGood(player, pos);
    return pos;
  }

  const track = window.filter(isTrackFix);
  if (track.length) {
    const pos = positionFromFixes(track, true);
    rememberGood(player, pos);
    return pos;
  }

  const ranked = window.filter((f) => usableAccuracy(f.accuracy) && !f.teleport);
  if (ranked.length) {
    const best = ranked.reduce((a, b) => (a.accuracy <= b.accuracy ? a : b));
    return {
      lat: best.lat,
      lng: best.lng,
      accuracy: best.accuracy,
      ts: best.ts,
      stale: true,
      samples: 1,
    };
  }

  const prev = player.lastGood;
  if (prev && now - prev.ts <= STALE_MAX_AGE_MS) {
    return { ...prev, stale: true };
  }
  return null;
}

/**
 * True when the players are within 15 m, or when their accuracy circles still
 * overlap after each radius is capped at 30 m — and the centres are within 40 m.
 * The 18 m "I'm standing next to them" case passes when both phones are ±10 m.
 * A ±150 m desktop fix cannot authorize a tag from across campus.
 */
function tagProximityOk(distanceM, acc1, acc2) {
  if (!Number.isFinite(distanceM)) return false;
  if (distanceM <= TAG_DISTANCE_M) return true;
  if (distanceM > TAG_ABS_MAX_M) return false;
  if (!usableAccuracy(acc1) || !usableAccuracy(acc2)) return false;
  const a = Math.min(acc1, TAG_RADIUS_CAP_M);
  const b = Math.min(acc2, TAG_RADIUS_CAP_M);
  return a + b - distanceM > 0;
}

/* ------------------------------------------------------------------ */
/* Serialization (per-socket — 3-digit codes are NEVER leaked)         */
/* ------------------------------------------------------------------ */

function serializeFor(room, sessionId) {
  const me = room.players.get(sessionId) || null;
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      sessionId: p.sessionId,
      nickname: p.nickname,
      isTagged: p.isTagged,
      connected: p.connected,
      hasLocation: !!p.lastLocation,
      isHost: p.sessionId === room.hostSessionId,
    });
  }
  players.sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    return a.nickname.localeCompare(b.nickname);
  });

  return {
    roomCode: room.code,
    phase: room.phase,
    host: room.hostSessionId === sessionId,
    hostSessionId: room.hostSessionId,
    settings: {
      roundMinutes: room.settings.roundMinutes, // number | null (no limit)
      pingInterval: room.settings.pingInterval,
      seekerWait: room.settings.seekerWait,
      boundary: room.settings.boundary,
    },
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    serverTime: Date.now(),
    you: me
      ? {
          sessionId: me.sessionId,
          nickname: me.nickname,
          code: me.code,          // only ever sent to its owner
          isTagged: me.isTagged,
          connected: me.connected,
        }
      : null,
    players,
  };
}

function broadcastRoomState(room) {
  if (!room || !rooms.has(room.code)) return;
  for (const [sessionId, p] of room.players) {
    const s = socketFor(p);
    if (s) s.emit('room_state', serializeFor(room, sessionId));
  }
}

/* ------------------------------------------------------------------ */
/* Room / player lifecycle                                             */
/* ------------------------------------------------------------------ */

function addPlayer(room, sessionId, nickname) {
  if (room.players.size >= MAX_PLAYERS) return null;
  if (room.codesPool.length === 0) return null;
  const code = room.codesPool.pop();
  const player = {
    sessionId,
    nickname,
    code,
    isTagged: false,
    lastLocation: null,          // latest raw fix (unfiltered)
    fixes: [],                   // raw ring buffer, last ~10 s
    lastTrackedFix: null,        // last fix admitted into the median
    lastGood: null,              // last median built from ≤ 50 m fixes
    sticky: null,                // last position ever broadcast; markers do not vanish
    lastChatAt: 0,
    connected: true,
    socketId: null,
    graceTimer: null,
    joinedAt: Date.now(),
  };
  room.players.set(sessionId, player);
  return player;
}

function clearGrace(player) {
  if (player && player.graceTimer) {
    clearTimeout(player.graceTimer);
    player.graceTimer = null;
  }
}

function scheduleGrace(room, player) {
  clearGrace(player);
  player.graceTimer = setTimeout(() => {
    player.graceTimer = null;
    const live = rooms.get(room.code);
    if (!live) return;
    const p = live.players.get(player.sessionId);
    if (!p || p.connected) return;
    log(`Room ${live.code}: grace expired for ${p.nickname}`);
    removePlayer(live, p.sessionId);
  }, GRACE_MS);
}

function stopRoomTimers(room) {
  if (room.pingTimer) clearInterval(room.pingTimer);
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.pingTimer = null;
  room.tickInterval = null;
}

function destroyRoom(room) {
  stopRoomTimers(room);
  for (const p of room.players.values()) clearGrace(p);
  rooms.delete(room.code);
  log(`Room ${room.code} destroyed`);
}

function removePlayer(room, sessionId) {
  const p = room.players.get(sessionId);
  if (!p) return;
  clearGrace(p);
  room.players.delete(sessionId);

  const s = socketFor(p);
  if (s) {
    s.leave(room.code);
    s.data.roomCode = null;
  }

  if (room.players.size === 0) {
    destroyRoom(room);
    return;
  }

  broadcastRoomState(room);
  if (room.phase === 'running') {
    checkWinCondition(room);
    broadcastPings(room);
  }
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */

function startPingTimer(room) {
  if (room.pingTimer) clearInterval(room.pingTimer);
  const intervalMs = room.stage === 'gather' ? GATHER_PING_MS : room.settings.pingInterval * 1000;
  room.pingTimer = setInterval(() => {
    if (room.phase !== 'running') return;
    broadcastPings(room);
  }, intervalMs);
}

function beginHunt(room, now) {
  room.stage = 'hunt';
  room.endsAt = room.settings.roundMinutes
    ? now + room.settings.roundMinutes * 60 * 1000
    : null;
  startPingTimer(room);
}

function lockCenter(room) {
  if (room.center) return;
  const pts = [];
  for (const p of room.players.values()) {
    const pos = p.sticky || p.lastGood || p.lastLocation;
    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lng)) pts.push(pos);
  }
  if (!pts.length) {
    room.centerPending = true;
    return;
  }
  room.center = {
    lat: pts.reduce((sum, p) => sum + p.lat, 0) / pts.length,
    lng: pts.reduce((sum, p) => sum + p.lng, 0) / pts.length,
  };
  room.centerPending = false;
  log(`Room ${room.code} center locked at ${room.center.lat.toFixed(5)},${room.center.lng.toFixed(5)}`);
}

function advanceStage(room, now) {
  if (room.phase !== 'running') return;
  if (room.stage === 'gather' && now >= room.gatherEndsAt) {
    lockCenter(room);
    if (room.settings.seekerWait > 0) {
      room.stage = 'hiding';
      startPingTimer(room);
    } else {
      beginHunt(room, now);
    }
    log(`Room ${room.code} stage -> ${room.stage}`);
    broadcastPings(room);
    broadcastTimeRemaining(room);
  }
  if (room.stage === 'hiding' && now >= room.huntStartsAt) {
    beginHunt(room, now);
    log(`Room ${room.code} hunt started`);
    broadcastPings(room);
    broadcastTimeRemaining(room);
  }
  if (room.centerPending && room.stage !== 'gather') {
    lockCenter(room);
    if (room.center) broadcastTimeRemaining(room);
  }
  if (room.stage === 'hunt' && room.endsAt && now >= room.endsAt) {
    endGame(room, 'survivors', 'time');
  }
}

function startTicker(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.lastTimeBroadcast = 0;
  room.tickInterval = setInterval(() => {
    if (room.phase !== 'running') return;
    const now = Date.now();
    advanceStage(room, now);
    if (room.phase !== 'running') return;
    if (now - room.lastTimeBroadcast >= TIME_BROADCAST_MS) {
      room.lastTimeBroadcast = now;
      broadcastTimeRemaining(room);
    }
  }, TICK_MS);
}

function stagePayload(room) {
  const now = Date.now();
  const preHunt = room.stage === 'gather' || room.stage === 'hiding';
  return {
    stage: room.stage || null,
    msLeft: !preHunt && room.endsAt ? Math.max(0, room.endsAt - now) : null,
    msUntilHunt: preHunt && room.huntStartsAt ? Math.max(0, room.huntStartsAt - now) : null,
    center: room.center || null,
    boundary: room.settings.boundary,
    radiusM: PLAY_RADIUS_M,
    seekerWait: room.settings.seekerWait,
    serverTime: now,
  };
}

function broadcastTimeRemaining(room) {
  if (!rooms.has(room.code)) return;
  const payload = stagePayload(room);
  for (const p of room.players.values()) {
    const s = socketFor(p);
    if (s) s.emit('time_remaining', payload);
  }
}

/** Last smoothed fix, or the last one we already showed, so a marker never blinks out. */
function displayPosition(player, now) {
  const pos = pingPosition(player, now);
  if (pos) {
    player.sticky = pos;
    return pos;
  }
  if (player.sticky) return { ...player.sticky, stale: true };
  if (player.lastLocation) {
    return {
      lat: player.lastLocation.lat,
      lng: player.lastLocation.lng,
      accuracy: player.lastLocation.accuracy,
      ts: player.lastLocation.ts,
      stale: true,
      samples: 1,
    };
  }
  return null;
}

function canSee(room, viewer, other) {
  if (viewer.sessionId === other.sessionId) return false;
  if (room.stage === 'gather') return true;
  const viewerIsZombie = viewer.isTagged;
  const otherIsZombie = other.isTagged;
  if (viewerIsZombie === otherIsZombie) return false;
  // The seeker waits blind. Survivors can still see where the seeker is standing.
  if (room.stage === 'hiding' && viewerIsZombie && !otherIsZombie) return false;
  return true;
}

/**
 * Visibility:
 *   gather  -> everyone sees everyone, so the starting circle is shared
 *   hiding  -> survivors see the seeker; the seeker sees nobody
 *   hunt    -> opposite teams only
 * A player who has ever had a fix keeps that marker until they leave or change team.
 */
function broadcastPings(room) {
  if (!rooms.has(room.code) || room.phase !== 'running') return;
  const all = [...room.players.values()];
  const now = Date.now();
  const resolved = new Map();
  for (const p of all) resolved.set(p.sessionId, displayPosition(p, now));

  for (const viewer of all) {
    const s = socketFor(viewer);
    if (!s || !viewer.connected) continue;

    const pings = [];
    for (const other of all) {
      if (!canSee(room, viewer, other)) continue;

      // During the initial gather, do not broadcast a player who has no
      // real fix yet (or whose fix is very poor). This stops everyone
      // from appearing on top of each other before GPS has locked on.
      if (room.stage === 'gather') {
        const fix = other.lastLocation;
        if (!fix || !Number.isFinite(fix.accuracy) || fix.accuracy > 50) continue;
      }

      const pos = resolved.get(other.sessionId);
      if (!pos) continue;

      pings.push({
        id: other.sessionId,
        nickname: other.nickname,
        lat: pos.lat,
        lng: pos.lng,
        accuracy: pos.accuracy,
        ts: pos.ts,
        stale: pos.stale,
        samples: pos.samples,
        role: other.isTagged ? 'zombie' : 'survivor',
      });
    }

    if (pings.length > 0 && room.stage !== 'gather') {
      const summary = pings
        .map(
          (p) =>
            `${p.nickname}[${p.role === 'zombie' ? 'Z' : 'S'}]` +
            `\u00b1${p.accuracy ? Math.round(p.accuracy) + 'm' : '?'}` +
            `${p.stale ? ' stale' : ''}` +
            `@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
        )
        .join('  ');
      log(`[ping] -> ${viewer.nickname} (${viewer.isTagged ? 'Z' : 'S'}): ${summary}`);
    }

    s.emit('ping_batch', { pings, serverTime: now, stage: room.stage });
  }
}

function sendChatHistory(socket, room) {
  if (!socket || !room) return;
  socket.emit('chat_history', { messages: room.chat || [] });
}

function sendRole(socket, room, player) {
  socket.emit('game_started', {
    code: player.code,
    isTagged: player.isTagged,
    endsAt: room.endsAt,
    roundMinutes: room.settings.roundMinutes,
    pingInterval: room.settings.pingInterval,
    ...stagePayload(room),
  });
  sendChatHistory(socket, room);
}

function checkWinCondition(room) {
  if (room.phase !== 'running') return;
  const players = [...room.players.values()];
  if (players.length === 0) return;
  if (players.every((p) => p.isTagged)) {
    endGame(room, 'zombies', 'all_tagged');
  }
}

function endGame(room, winner, reason) {
  if (room.phase === 'ended') return;
  room.phase = 'ended';
  stopRoomTimers(room);
  clearGraceForAll(room);

  const payload = {
    winner, // 'zombies' | 'survivors'
    reason, // 'all_tagged' | 'time'
    players: [...room.players.values()].map((p) => ({
      sessionId: p.sessionId,
      nickname: p.nickname,
      isTagged: p.isTagged,
    })),
    serverTime: Date.now(),
  };

  for (const p of room.players.values()) {
    const s = socketFor(p);
    if (!s) continue;
    s.emit('game_over', payload);
    s.leave(room.code);
    s.data.roomCode = null;
  }

  rooms.delete(room.code);
  log(`Room ${room.code} ended — winner=${winner} reason=${reason}`);
}

function clearGraceForAll(room) {
  for (const p of room.players.values()) clearGrace(p);
}

/* ------------------------------------------------------------------ */
/* Socket handlers                                                     */
/* ------------------------------------------------------------------ */

function detachFromCurrentRoom(socket, excludeCode) {
  const code = socket.data.roomCode;
  if (!code) return;
  if (excludeCode && code === excludeCode) return;
  const room = rooms.get(code);
  const sessionId = socket.data.sessionId;
  socket.leave(code);
  socket.data.roomCode = null;
  if (room && sessionId && room.players.has(sessionId)) {
    removePlayer(room, sessionId);
  }
}

io.on('connection', (socket) => {
  socket.data.sessionId = null;
  socket.data.roomCode = null;

  /* ---------------- create ---------------- */
  socket.on('create_room', (payload = {}, cb = () => {}) => {
    try {
      const sessionId = normSessionId(payload.sessionId);
      const nickname = normNickname(payload.nickname);
      if (!sessionId) return cb({ ok: false, error: 'Missing session id.' });
      if (!nickname) return cb({ ok: false, error: 'Please enter a nickname.' });

      detachFromCurrentRoom(socket, null);

      const settings = readSettings(payload, null);

      const code = makeRoomCode();
      const room = {
        code,
        hostSessionId: sessionId,
        players: new Map(),
        settings,
        phase: 'lobby',
        stage: null,
        startedAt: null,
        endsAt: null,
        gatherEndsAt: null,
        huntStartsAt: null,
        center: null,
        centerPending: false,
        chat: [],
        codesPool: makeCodePool(),
        pingTimer: null,
        tickInterval: null,
        lastTimeBroadcast: 0,
        createdAt: Date.now(),
      };
      rooms.set(code, room);

      const player = addPlayer(room, sessionId, nickname);
      if (!player) {
        rooms.delete(code);
        return cb({ ok: false, error: 'Could not create the room. Please retry.' });
      }

      player.socketId = socket.id;
      socket.data.sessionId = sessionId;
      socket.data.roomCode = code;
      socket.join(code);

      log(`Room ${code} created by ${nickname}`);
      cb({ ok: true, roomCode: code });
      broadcastRoomState(room);
      sendChatHistory(socket, room);
    } catch (err) {
      log('create_room error', err);
      cb({ ok: false, error: 'Server error creating the room.' });
    }
  });

  /* ---------------- join ---------------- */
  socket.on('join_room', (payload = {}, cb = () => {}) => {
    try {
      const sessionId = normSessionId(payload.sessionId);
      const nickname = normNickname(payload.nickname);
      const roomCode = String(payload.roomCode || '').trim().toUpperCase();
      if (!sessionId) return cb({ ok: false, error: 'Missing session id.' });
      if (!roomCode) return cb({ ok: false, error: 'Enter a room code.' });

      const room = getRoom(roomCode);
      if (!room) return cb({ ok: false, error: 'No game found with that room code.' });

      detachFromCurrentRoom(socket, room.code);

      let player = room.players.get(sessionId);

      if (player) {
        // Same device rejoining its own slot.
        clearGrace(player);
        if (nickname) player.nickname = nickname;
      } else {
        if (room.phase !== 'lobby') {
          return cb({ ok: false, error: 'That game has already started.' });
        }
        if (!nickname) return cb({ ok: false, error: 'Please enter a nickname.' });
        if (room.players.size >= MAX_PLAYERS) {
          return cb({ ok: false, error: 'That room is full (999 players max).' });
        }
        if (room.codesPool.length === 0) {
          return cb({ ok: false, error: 'No 3-digit codes left in this room.' });
        }
        player = addPlayer(room, sessionId, nickname);
        if (!player) return cb({ ok: false, error: 'That room is full.' });
      }

      player.socketId = socket.id;
      player.connected = true;
      socket.data.sessionId = sessionId;
      socket.data.roomCode = room.code;
      socket.join(room.code);

      cb({ ok: true, roomCode: room.code, phase: room.phase });
      broadcastRoomState(room);

      if (room.phase === 'running') {
        sendRole(socket, room, player);
        broadcastPings(room);
        broadcastTimeRemaining(room);
      } else {
        sendChatHistory(socket, room);
      }
    } catch (err) {
      log('join_room error', err);
      cb({ ok: false, error: 'Server error joining the room.' });
    }
  });

  /* ---------------- reconnect ---------------- */
  socket.on('reconnect_room', (payload = {}, cb = () => {}) => {
    try {
      const sessionId = normSessionId(payload.sessionId);
      const roomCode = String(payload.roomCode || '').trim().toUpperCase();
      if (!sessionId) return cb({ ok: false, error: 'MISSING_SESSION' });

      const room = getRoom(roomCode);
      if (!room) return cb({ ok: false, error: 'ROOM_GONE' });

      const player = room.players.get(sessionId);
      if (!player) return cb({ ok: false, error: 'NOT_IN_ROOM' });

      clearGrace(player);
      player.socketId = socket.id;
      player.connected = true;

      socket.data.sessionId = sessionId;
      socket.data.roomCode = room.code;
      socket.join(room.code);

      log(`Room ${room.code}: ${player.nickname} reconnected`);
      cb({ ok: true, roomCode: room.code, phase: room.phase });
      broadcastRoomState(room);

      if (room.phase === 'running') {
        sendRole(socket, room, player);
        broadcastPings(room);
        broadcastTimeRemaining(room);
      } else {
        sendChatHistory(socket, room);
      }
    } catch (err) {
      log('reconnect_room error', err);
      cb({ ok: false, error: 'Server error reconnecting.' });
    }
  });

  /* ---------------- settings ---------------- */
  socket.on('update_settings', (payload = {}, cb = () => {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    if (room.hostSessionId !== socket.data.sessionId) {
      return cb({ ok: false, error: 'Only the host can change settings.' });
    }
    if (room.phase !== 'lobby') {
      return cb({ ok: false, error: 'Settings are locked once the game starts.' });
    }
    room.settings = readSettings(payload, room.settings);
    broadcastRoomState(room);
    cb({ ok: true, settings: room.settings });
  });

  /* ---------------- start ---------------- */
  socket.on('start_game', (_payload = {}, cb = () => {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    if (room.hostSessionId !== socket.data.sessionId) {
      return cb({ ok: false, error: 'Only the host can start the game.' });
    }
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'The game is already running.' });

    const players = [...room.players.values()];
    if (players.length < 2) {
      return cb({ ok: false, error: 'You need at least 2 players to start.' });
    }

    const now = Date.now();
    room.phase = 'running';
    room.stage = 'gather';
    room.startedAt = now;
    room.gatherEndsAt = now + GATHER_MS;
    room.huntStartsAt = room.gatherEndsAt + room.settings.seekerWait * 1000;
    room.endsAt = null;
    room.center = null;
    room.centerPending = false;

    for (const p of players) p.isTagged = false;

    const patientZero = players[Math.floor(Math.random() * players.length)];
    patientZero.isTagged = true;

    log(`Room ${room.code} started — patient zero: ${patientZero.nickname}`);

    for (const p of players) {
      const s = socketFor(p);
      if (s) sendRole(s, room, p);
    }

    startPingTimer(room);
    startTicker(room);
    broadcastRoomState(room);
    broadcastTimeRemaining(room);
    broadcastPings(room);

    cb({ ok: true });
  });

  /* ---------------- location ---------------- */
  socket.on('location_update', (payload = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.sessionId);
    if (!player) return;

    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      log(`[loc] ${player.nickname}: rejected invalid coords`, payload);
      return;
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      log(`[loc] ${player.nickname}: rejected out-of-range coords`, payload);
      return;
    }

    const accuracy = Number(payload.accuracy);
    const acc = usableAccuracy(accuracy) ? accuracy : null;
    const now = Date.now();
    const prev = player.lastLocation;
    const movedM = prev ? haversineM(prev.lat, prev.lng, lat, lng) : null;

    // Raw fix is always kept. Smoothing reads this buffer later; nothing here
    // is rounded or offset. Fixes worse than 50 m stay in the buffer so a ping
    // can fall back to them, but they are left out of the median.
    const fix = { lat, lng, accuracy: acc, ts: now, teleport: false };
    fix.teleport = looksLikeTeleport(player, fix);
    player.lastLocation = fix;
    player.fixes.push(fix);
    pruneFixes(player, now);

    const tracked = acc !== null && acc <= TRACK_MAX_ACCURACY_M && !fix.teleport;
    if (tracked) player.lastTrackedFix = fix;
    const accStr = acc !== null ? `${Math.round(acc)}m` : '?';
    const prevAcc = prev && usableAccuracy(prev.accuracy) ? prev.accuracy : null;
    const accChanged = !prev || prevAcc === null || Math.abs(prevAcc - acc) > 20;
    const poor = acc === null || acc > TRACK_MAX_ACCURACY_M;

    if (!prev || poor || accChanged) {
      const movedStr = movedM !== null ? ` moved=${movedM.toFixed(1)}m` : '';
      const note = fix.teleport
        ? '  <-- teleport, not tracked'
        : !tracked
          ? '  <-- not tracked (>50m or unknown)'
          : '';
      log(
        `[loc] ${player.nickname} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)} acc=${accStr}${movedStr}${note}`
      );
    }
  });

  /* ---------------- tag ---------------- */
  socket.on('submit_tag', (payload = {}, cb = () => {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return cb({ ok: false, error: 'Room not found.' });
    if (room.phase !== 'running') return cb({ ok: false, error: 'The game is not running.' });

    const tagger = room.players.get(socket.data.sessionId);
    if (!tagger) return cb({ ok: false, error: 'You are not in this room.' });
    if (!tagger.isTagged) return cb({ ok: false, error: 'Only zombies can tag players.' });

    const code = String(payload.code || '').trim();
    if (!/^\d{3}$/.test(code)) return cb({ ok: false, error: 'Enter a 3-digit code.' });

    let target = null;
    for (const p of room.players.values()) {
      if (p.code === code && !p.isTagged) {
        target = p;
        break;
      }
    }
    if (!target) {
      log(`[tag] ${tagger.nickname}: FAILED code=${code} (no living survivor)`);
      return cb({ ok: false, error: 'No living survivor with that code.' });
    }

    if (room.stage !== 'hunt') {
      return cb({ ok: false, error: 'The seeker is still waiting. Tags open when the hunt starts.' });
    }

    target.isTagged = true;
    log(`[tag] ${tagger.nickname} tagged ${target.nickname} (${code})`);

    cb({ ok: true, tagged: target.nickname });

    for (const p of room.players.values()) {
      const s = socketFor(p);
      if (!s) continue;
      s.emit('player_tagged', {
        sessionId: target.sessionId,
        nickname: target.nickname,
        byNickname: tagger.nickname,
        youAreZombie: p.sessionId === target.sessionId,
      });
    }

    broadcastRoomState(room);
    broadcastPings(room);
    checkWinCondition(room);
  });

  /* ---------------- chat ---------------- */
  socket.on('chat', (payload = {}, cb = () => {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.phase === 'ended') return cb({ ok: false, error: 'No game to chat in.' });
    const player = room.players.get(socket.data.sessionId);
    if (!player) return cb({ ok: false, error: 'You are not in this room.' });

    const text = normChat(payload.text);
    if (!text) return cb({ ok: false, error: 'Type a message.' });

    const now = Date.now();
    if (player.lastChatAt && now - player.lastChatAt < CHAT_GAP_MS) {
      return cb({ ok: false, error: 'Slow down a little.' });
    }
    player.lastChatAt = now;

    const msg = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      nickname: player.nickname,
      role: player.isTagged ? 'zombie' : 'survivor',
      sessionId: player.sessionId,
      text,
      ts: now,
    };
    room.chat.push(msg);
    if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);

    for (const p of room.players.values()) {
      const s = socketFor(p);
      if (s) s.emit('chat_message', msg);
    }
    cb({ ok: true });
  });

  socket.on('leave_room', () => {
    const code = socket.data.roomCode;
    detachFromCurrentRoom(socket, null);
    socket.emit('room_left', { roomCode: code || null });
  });

  /* ---------------- disconnect ---------------- */
  socket.on('disconnect', (reason) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(socket.data.sessionId);
    if (!player) return;
    // Ignore stale disconnects from a socket that has already been replaced.
    if (player.socketId !== socket.id) return;

    player.socketId = null;
    player.connected = false;
    scheduleGrace(room, player);
    broadcastRoomState(room);
    log(`Room ${code}: ${player.nickname} disconnected (${reason}) — ${GRACE_MS / 1000}s grace`);
  });
});

/* ------------------------------------------------------------------ */
/* Render free-tier keep-alive                                         */
/* ------------------------------------------------------------------ */
/*
 * Render's free tier spins the service down after 15 minutes WITHOUT INBOUND
 * traffic. An idle open WebSocket does not count. So every 4 minutes we emit
 * a lightweight `heartbeat` to every socket; the client immediately replies
 * with `heartbeat_ack`, which IS inbound traffic and resets the idle timer.
 */
setInterval(() => {
  const t = Date.now();
  io.emit('heartbeat', { t });
}, KEEPALIVE_MS).unref?.();

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

server.listen(PORT, () => {
  log(`Infection server listening on :${PORT}`);
  log(`Keep-alive heartbeat every ${KEEPALIVE_MS / 60000} min (Render idle limit is 15 min)`);
});

process.on('SIGTERM', () => {
  log('SIGTERM received — shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});