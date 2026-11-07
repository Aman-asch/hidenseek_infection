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

const TICK_MS = 500;                     // internal tick (cheap, no I/O)
const TIME_BROADCAST_MS = 5000;          // spec: broadcast time-remaining every 5s

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
    lastLocation: null,
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
  const intervalMs = room.settings.pingInterval * 1000;
  room.pingTimer = setInterval(() => {
    if (room.phase !== 'running') return;
    broadcastPings(room);
  }, intervalMs);
}

function startTicker(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.lastTimeBroadcast = 0;
  room.tickInterval = setInterval(() => {
    if (room.phase !== 'running') return;
    const now = Date.now();

    if (room.endsAt && now >= room.endsAt) {
      endGame(room, 'survivors', 'time');
      return;
    }
    if (now - room.lastTimeBroadcast >= TIME_BROADCAST_MS) {
      room.lastTimeBroadcast = now;
      broadcastTimeRemaining(room);
    }
  }, TICK_MS);
}

function msRemaining(room) {
  if (!room.endsAt) return null;
  return Math.max(0, room.endsAt - Date.now());
}

function broadcastTimeRemaining(room) {
  if (!rooms.has(room.code)) return;
  const payload = { msLeft: msRemaining(room), serverTime: Date.now() };
  for (const p of room.players.values()) {
    const s = socketFor(p);
    if (s) s.emit('time_remaining', payload);
  }
}

/**
 * Visibility rules:
 *   Survivor  -> sees all ZOMBIES (tagged players)
 *   Zombie    -> sees all LIVING SURVIVORS (untagged players)
 * Nobody sees their own team, and nobody sees continuous positions.
 */
function broadcastPings(room) {
  if (!rooms.has(room.code) || room.phase !== 'running') return;
  const all = [...room.players.values()];
  const now = Date.now();

  for (const viewer of all) {
    const s = socketFor(viewer);
    if (!s || !viewer.connected) continue;

    const pings = [];
    for (const other of all) {
      if (other.sessionId === viewer.sessionId) continue;
      if (!other.lastLocation) continue;

      const viewerIsZombie = viewer.isTagged;
      const otherIsZombie = other.isTagged;
      if (viewerIsZombie === otherIsZombie) continue; // same team -> hidden

      pings.push({
        id: other.sessionId,
        nickname: other.nickname,
        lat: other.lastLocation.lat,   // raw, unrounded, unoffset
        lng: other.lastLocation.lng,
        accuracy: other.lastLocation.accuracy,
        ts: other.lastLocation.ts,
        role: otherIsZombie ? 'zombie' : 'survivor',
      });
    }

    if (pings.length > 0) {
      const summary = pings
        .map(
          (p) =>
            `${p.nickname}[${p.role === 'zombie' ? 'Z' : 'S'}]` +
            `\u00b1${p.accuracy ? Math.round(p.accuracy) + 'm' : '?'}` +
            `@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`
        )
        .join('  ');
      log(`[ping] -> ${viewer.nickname} (${viewer.isTagged ? 'Z' : 'S'}): ${summary}`);
    }

    // volatile: never queue stale pings for a briefly disconnected client
    s.volatile.emit('ping_batch', { pings, serverTime: now });
  }
}

function sendRole(socket, room, player) {
  socket.emit('game_started', {
    code: player.code,
    isTagged: player.isTagged,
    endsAt: room.endsAt,
    roundMinutes: room.settings.roundMinutes,
    pingInterval: room.settings.pingInterval,
    serverTime: Date.now(),
  });
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

      const noLimit = !!payload.noLimit;
      const roundMinutes = noLimit
        ? null
        : clampInt(payload.roundMinutes, ROUND_MIN, ROUND_MAX, ROUND_DEFAULT);
      const pingInterval = clampInt(payload.pingInterval, PING_MIN, PING_MAX, PING_DEFAULT);

      const code = makeRoomCode();
      const room = {
        code,
        hostSessionId: sessionId,
        players: new Map(),
        settings: { roundMinutes, pingInterval },
        phase: 'lobby',
        startedAt: null,
        endsAt: null,
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
    room.settings.roundMinutes = payload.noLimit
      ? null
      : clampInt(payload.roundMinutes, ROUND_MIN, ROUND_MAX, ROUND_DEFAULT);
    room.settings.pingInterval = clampInt(payload.pingInterval, PING_MIN, PING_MAX, PING_DEFAULT);
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

    room.phase = 'running';
    room.startedAt = Date.now();
    room.endsAt = room.settings.roundMinutes
      ? room.startedAt + room.settings.roundMinutes * 60 * 1000
      : null;

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
    const prev = player.lastLocation;
    const movedM = prev ? haversineM(prev.lat, prev.lng, lat, lng) : null;

    // Store raw, untouched coordinates. No rounding, no offsets.
    player.lastLocation = {
      lat,
      lng,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      ts: Date.now(),
    };

    // Log the first fix, every poor fix, and any significant accuracy change.
    const accStr = Number.isFinite(accuracy) ? `${Math.round(accuracy)}m` : '?';
    const prevAcc = prev && Number.isFinite(prev.accuracy) ? prev.accuracy : null;
    const accChanged =
      !prev || prevAcc === null || Math.abs(prevAcc - accuracy) > 20;
    const poor = Number.isFinite(accuracy) && accuracy > 100;

    if (!prev || poor || accChanged) {
      const movedStr = movedM !== null ? ` moved=${movedM.toFixed(1)}m` : '';
      log(
        `[loc] ${player.nickname} lat=${lat.toFixed(6)} lng=${lng.toFixed(6)} acc=${accStr}${movedStr}${poor ? '  <-- POOR' : ''}`
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

    target.isTagged = true;

    const distStr =
      tagger.lastLocation && target.lastLocation
        ? `dist=${haversineM(
            tagger.lastLocation.lat,
            tagger.lastLocation.lng,
            target.lastLocation.lat,
            target.lastLocation.lng
          ).toFixed(1)}m`
        : 'dist=unknown';
    const accStr =
      tagger.lastLocation && target.lastLocation
        ? `taggerAcc=\u00b1${tagger.lastLocation.accuracy ? Math.round(tagger.lastLocation.accuracy) + 'm' : '?'} targetAcc=\u00b1${target.lastLocation.accuracy ? Math.round(target.lastLocation.accuracy) + 'm' : '?'}`
        : '';
    log(
      `[tag] ${tagger.nickname} tagged ${target.nickname} (${code}) ${distStr} ${accStr}`
    );

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

  /* ---------------- leave ---------------- */
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