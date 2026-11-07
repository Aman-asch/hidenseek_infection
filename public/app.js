/* Infection — client */
(function () {
  'use strict';

  /* ================================================================ */
  /* Constants                                                        */
  /* ================================================================ */

  const LS_SESSION = 'infection.sessionId';
  const LS_NICK = 'infection.nickname';
  const LS_ROOM = 'infection.roomCode';
  const LS_SETTINGS = 'infection.settings';
  const LS_MAP_STYLE = 'infection.mapStyle';

  const GEO_OPTS_HIGH = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
  const GEO_OPTS_LOW = { enableHighAccuracy: false, maximumAge: 5000, timeout: 20000 };
  const GPS_RETRY_MS = 10000;

  const GPS_MAX_ACCURACY_M = 50;
  const GPS_MIN_ACCURACY_M = 1;
  const GPS_GATE_CHI2 = 16;
  const GPS_GATE_MIN_M = 35;
  const GPS_STATIONARY_SPEED = 0.7;
  const GPS_MAX_DT_S = 10;
  const GPS_HEARTBEAT_MS = 8000;
  const GPS_MIN_SEND_M = 4;
  const GPS_WARMUP_FIXES = 2;
  const GPS_MIN_SEND_GAP_MS = 800;

  const M_PER_DEG_LAT = 111320;

  /* ================================================================ */
  /* GPS engine — 2D constant-velocity Kalman filter in local metres   */
  /* ================================================================ */

  class GpsKalman2D {
    constructor() { this.reset(); }

    reset() {
      this.initialized = false;
      this.refLat = 0;
      this.refLng = 0;
      this.mPerDegLng = M_PER_DEG_LAT;
      this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
      this.P = new Float64Array(16);
      this.lastTs = 0;
      this.rawAccEma = null;
      this.accepted = 0;
      this.rejected = 0;
    }

    _project(lat, lng) {
      return {
        x: (lng - this.refLng) * this.mPerDegLng,
        y: (lat - this.refLat) * M_PER_DEG_LAT,
      };
    }

    _unproject(x, y) {
      return {
        lat: this.refLat + y / M_PER_DEG_LAT,
        lng: this.refLng + x / this.mPerDegLng,
      };
    }

    _symmetrize() {
      const P = this.P;
      for (let r = 0; r < 4; r++) {
        for (let c = r + 1; c < 4; c++) {
          const v = (P[r * 4 + c] + P[c * 4 + r]) / 2;
          P[r * 4 + c] = v;
          P[c * 4 + r] = v;
        }
      }
    }

    _predict(dt, speed) {
      const P = this.P;

      const sigmaA = Math.min(4.0, 0.4 + 0.9 * speed);
      const q = sigmaA * sigmaA;

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      const fp = new Float64Array(16);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s;
          if (r === 0) s = P[0 * 4 + c] + dt * P[2 * 4 + c];
          else if (r === 1) s = P[1 * 4 + c] + dt * P[3 * 4 + c];
          else if (r === 2) s = P[2 * 4 + c];
          else s = P[3 * 4 + c];
          fp[r * 4 + c] = s;
        }
      }
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let s;
          if (c === 0) s = fp[r * 4 + 0] + dt * fp[r * 4 + 2];
          else if (c === 1) s = fp[r * 4 + 1] + dt * fp[r * 4 + 3];
          else if (c === 2) s = fp[r * 4 + 2];
          else s = fp[r * 4 + 3];
          P[r * 4 + c] = s;
        }
      }

      const dt2 = dt * dt;
      const dt3 = dt2 * dt;
      P[0] += q * dt3 / 3;
      P[5] += q * dt3 / 3;
      P[2] += q * dt2 / 2;
      P[8] += q * dt2 / 2;
      P[7] += q * dt2 / 2;
      P[13] += q * dt2 / 2;
      P[10] += q * dt;
      P[15] += q * dt;

      this._symmetrize();
    }

    _snapshot(accepted, reason) {
      const { lat, lng } = this._unproject(this.x, this.y);
      const posSigma = Math.sqrt(Math.max(1, this.P[0] + this.P[5]));
      const accuracy = Math.max(posSigma, (this.rawAccEma || posSigma) * 0.6);
      return {
        accepted: !!accepted,
        reason: reason || null,
        lat,
        lng,
        accuracy,
        speed: Math.hypot(this.vx, this.vy),
        acceptedCount: this.accepted,
        rejectedCount: this.rejected,
      };
    }

    process(lat, lng, accuracy, timestampMs) {
      const acc = Math.max(
        GPS_MIN_ACCURACY_M,
        Number.isFinite(accuracy) ? accuracy : GPS_MAX_ACCURACY_M
      );

      if (!this.initialized) {
        if (acc > GPS_MAX_ACCURACY_M) {
          this.rejected++;
          return { accepted: false, reason: 'poor_accuracy', accuracy: acc };
        }
        this.refLat = lat;
        this.refLng = lng;
        this.mPerDegLng = M_PER_DEG_LAT * Math.max(0.1, Math.cos(lat * Math.PI / 180));
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;
        const p = acc * acc;
        const v = 25;
        this.P.fill(0);
        this.P[0] = p;
        this.P[5] = p;
        this.P[10] = v;
        this.P[15] = v;
        this.lastTs = timestampMs;
        this.rawAccEma = acc;
        this.initialized = true;
        this.accepted = 1;
        return {
          accepted: true,
          lat, lng,
          accuracy: acc,
          speed: 0,
          acceptedCount: 1,
          rejectedCount: this.rejected,
        };
      }

      const dtMs = timestampMs - this.lastTs;
      if (dtMs <= 0) return this._snapshot(false, 'duplicate');

      const dt = Math.min(GPS_MAX_DT_S, dtMs / 1000);
      const speedBefore = Math.hypot(this.vx, this.vy);

      this._predict(dt, speedBefore);
      this.lastTs = timestampMs;

      if (acc > GPS_MAX_ACCURACY_M) {
        this.rejected++;
        return { accepted: false, reason: 'poor_accuracy', accuracy: acc, speed: speedBefore };
      }

      const m = this._project(lat, lng);
      const R = acc * acc;
      const ix = m.x - this.x;
      const iy = m.y - this.y;

      const P = this.P;
      const s00 = P[0] + R;
      const s01 = P[1];
      const s10 = P[4];
      const s11 = P[5];
      const det = s00 * s11 - s01 * s10;
      if (Math.abs(det) < 1e-9) return this._snapshot(false, 'singular');

      const invDet = 1 / det;
      const si00 = s11 * invDet;
      const si01 = -s01 * invDet;
      const si10 = -s10 * invDet;
      const si11 = s00 * invDet;

      const maha2 = ix * (si00 * ix + si01 * iy) + iy * (si10 * ix + si11 * iy);
      const innovationDist = Math.hypot(ix, iy);
      if (maha2 > GPS_GATE_CHI2 && innovationDist > GPS_GATE_MIN_M) {
        this.rejected++;
        return { accepted: false, reason: 'outlier', accuracy: acc, speed: speedBefore };
      }

      const k0x = P[0] * si00 + P[1] * si10;
      const k0y = P[0] * si01 + P[1] * si11;
      const k1x = P[4] * si00 + P[5] * si10;
      const k1y = P[4] * si01 + P[5] * si11;
      const k2x = P[8] * si00 + P[9] * si10;
      const k2y = P[8] * si01 + P[9] * si11;
      const k3x = P[12] * si00 + P[13] * si10;
      const k3y = P[12] * si01 + P[13] * si11;

      this.x += k0x * ix + k0y * iy;
      this.y += k1x * ix + k1y * iy;
      this.vx += k2x * ix + k2y * iy;
      this.vy += k3x * ix + k3y * iy;

      const newP = new Float64Array(16);
      for (let c = 0; c < 4; c++) {
        newP[0 * 4 + c] = P[0 * 4 + c] - (k0x * P[0 * 4 + c] + k0y * P[1 * 4 + c]);
        newP[1 * 4 + c] = P[1 * 4 + c] - (k1x * P[0 * 4 + c] + k1y * P[1 * 4 + c]);
        newP[2 * 4 + c] = P[2 * 4 + c] - (k2x * P[0 * 4 + c] + k2y * P[1 * 4 + c]);
        newP[3 * 4 + c] = P[3 * 4 + c] - (k3x * P[0 * 4 + c] + k3y * P[1 * 4 + c]);
      }
      this.P = newP;
      this._symmetrize();

      this.rawAccEma = this.rawAccEma == null
        ? acc
        : this.rawAccEma + 0.15 * (acc - this.rawAccEma);
      this.accepted++;

      const newSpeed = Math.hypot(this.vx, this.vy);
      if (newSpeed < GPS_STATIONARY_SPEED && innovationDist < 8) {
        this.vx = 0;
        this.vy = 0;
      }

      return this._snapshot(true);
    }
  }

  let gpsFilter = new GpsKalman2D();
  let gpsHighAccuracy = true;
  let gpsFailures = 0;

  /* ================================================================ */
  /* Small helpers                                                    */
  /* ================================================================ */

  const $ = (id) => document.getElementById(id);

  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return 'Distance unknown';
    if (meters < 1000) return Math.round(meters) + ' m';
    return (meters / 1000).toFixed(1) + ' km';
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function timeAgo(ts) {
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 5) return 'just now';
    if (secs < 60) return secs + 's ago';
    return Math.round(secs / 60) + 'm ago';
  }

  /* ================================================================ */
  /* Session / persistence                                            */
  /* ================================================================ */

  let sessionId = localStorage.getItem(LS_SESSION);
  if (!sessionId) {
    sessionId = uuid();
    localStorage.setItem(LS_SESSION, sessionId);
  }

  /* ================================================================ */
  /* App state                                                        */
  /* ================================================================ */

  const S = {
    screen: 'home',
    roomCode: null,
    phase: 'lobby',
    isHost: false,
    players: [],
    settings: { roundMinutes: 15, pingInterval: 30, seekerWait: 30, boundary: 'circle' },
    myCode: null,
    isTagged: false,
    myPos: null,
    stage: null,
    center: null,
    boundary: 'circle',
    radiusM: 1000,

    map: null,
    mapReady: false,
    mapStyle: 'satellite',
    baseLayer: null,
    vectorRenderer: null,
    wakeLock: null,
    selfMarker: null,
    accuracyCircle: null,
    playCircle: null,
    pingMarkers: new Map(),
    centeredOnce: false,
    userPanned: false,
    fittedPlay: false,

    timerSync: null,
    watchId: null,
    gpsRetryTimer: null,
    lastLocationSentAt: 0,
    lastSentLat: null,
    lastSentLng: null,
    gpsOk: false,

    pingRafPending: false,
    pendingPings: null,
    chatOpen: false,
    chatUnread: 0,
  };

  /* ================================================================ */
  /* DOM refs                                                         */
  /* ================================================================ */

  const el = {
    overlay: $('connect-overlay'),
    connectTitle: $('connect-title'),
    connectMsg: $('connect-msg'),
    btnRetry: $('btn-retry'),

    screenHome: $('screen-home'),
    screenRoom: $('screen-room'),
    screenGame: $('screen-game'),

    nickname: $('nickname'),
    btnShowCreate: $('btn-show-create'),
    createPanel: $('create-panel'),
    roundRange: $('round-range'),
    roundVal: $('round-val'),
    noLimit: $('no-limit'),
    pingRange: $('ping-range'),
    pingVal: $('ping-val'),
    waitRange: $('wait-range'),
    waitVal: $('wait-val'),
    boundaryNone: $('boundary-none'),
    boundaryCircle: $('boundary-circle'),
    btnCreate: $('btn-create'),

    btnShowJoin: $('btn-show-join'),
    joinPanel: $('join-panel'),
    roomInput: $('room-input'),
    btnJoin: $('btn-join'),
    iosHint: $('ios-install-hint'),

    roomCode: $('room-code'),
    btnLeave: $('btn-leave'),
    btnRoomChat: $('btn-room-chat'),
    myCode: $('my-code'),
    myStatus: $('my-status'),
    hostControls: $('host-controls'),
    hostRoundRange: $('host-round-range'),
    hostRoundVal: $('host-round-val'),
    hostNoLimit: $('host-no-limit'),
    hostPingRange: $('host-ping-range'),
    hostPingVal: $('host-ping-val'),
    hostWaitRange: $('host-wait-range'),
    hostWaitVal: $('host-wait-val'),
    hostBoundaryNone: $('host-boundary-none'),
    hostBoundaryCircle: $('host-boundary-circle'),
    btnStart: $('btn-start'),
    playerList: $('player-list'),
    playerCount: $('player-count'),

    map: $('map'),
    timer: $('timer'),
    phaseLabel: $('phase-label'),
    roleBadge: $('role-badge'),
    hudCode: $('hud-code'),
    hudGps: $('hud-gps'),
    btnPlayers: $('btn-players'),
    btnTag: $('btn-tag'),
    btnChat: $('btn-chat'),
    btnRecenter: $('btn-recenter'),
    btnZoomIn: $('btn-zoom-in'),
    btnZoomOut: $('btn-zoom-out'),
    btnFit: $('btn-fit'),
    btnMapPlain: $('btn-map-plain'),
    btnMapSat: $('btn-map-sat'),
    gpsBanner: $('gps-banner'),
    boundaryBanner: $('boundary-banner'),
    hiddenBanner: $('hidden-banner'),
    chatSheet: $('chat-sheet'),
    chatLog: $('chat-log'),
    chatForm: $('chat-form'),
    chatInput: $('chat-input'),
    btnChatClose: $('btn-chat-close'),

    modalTag: $('modal-tag'),
    tagInput: $('tag-input'),
    tagError: $('tag-error'),
    btnTagCancel: $('btn-tag-cancel'),
    btnTagSubmit: $('btn-tag-submit'),

    modalPlayers: $('modal-players'),
    modalPlayerList: $('modal-player-list'),
    btnPlayersClose: $('btn-players-close'),

    modalOver: $('modal-over'),
    overTitle: $('over-title'),
    overSub: $('over-sub'),
    overList: $('over-list'),
    btnOverClose: $('btn-over-close'),

    toasts: $('toasts'),
  };

  /* ================================================================ */
  /* Toasts                                                           */
  /* ================================================================ */

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = 'toast' + (kind ? ' ' + kind : '');
    node.textContent = message;
    el.toasts.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .25s';
      setTimeout(() => node.remove(), 260);
    }, 3600);
  }

  /* ================================================================ */
  /* Screens                                                          */
  /* ================================================================ */

  function setScreen(name) {
    S.screen = name;
    el.screenHome.hidden = name !== 'home';
    el.screenRoom.hidden = name !== 'room';
    el.screenGame.hidden = name !== 'game';

    if (name === 'game') {
      ensureMap();
      acquireWakeLock();
      requestAnimationFrame(() => {
        if (S.map) S.map.invalidateSize();
      });
      if (!window.__timerLoop) {
        window.__timerLoop = true;
        requestAnimationFrame(timerLoop);
      }
    } else {
      releaseWakeLock();
    }
  }

  function showOverlay(title, message) {
    el.connectTitle.textContent = title;
    el.connectMsg.textContent = message;
    el.overlay.hidden = false;
  }

  function hideOverlay() {
    el.overlay.hidden = true;
  }

  /* ================================================================ */
  /* Socket                                                           */
  /* ================================================================ */

  const socket = io({
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    timeout: 25000,
  });

  let hasConnectedOnce = false;

  socket.on('connect', () => {
    hideOverlay();
    hasConnectedOnce = true;

    const code = S.roomCode || localStorage.getItem(LS_ROOM);
    if (code) {
      socket.emit('reconnect_room', { sessionId, roomCode: code }, (res) => {
        if (!res || !res.ok) {
          S.roomCode = null;
          localStorage.removeItem(LS_ROOM);
          if (S.screen !== 'home') {
            setScreen('home');
            toast('Your game is no longer available.', 'error');
          }
        }
      });
    }
  });

  socket.on('disconnect', () => {
    if (!hasConnectedOnce) return;
    stopGps();
    showOverlay('Connection lost', 'Reconnecting… this may take up to a minute while the server wakes up.');
  });

  socket.on('connect_error', () => {
    showOverlay(
      hasConnectedOnce ? 'Connection lost' : 'Connecting to server…',
      'This may take up to a minute on first launch while the free server wakes up.'
    );
  });

  el.btnRetry.addEventListener('click', () => {
    showOverlay('Connecting to server…', 'Retrying now…');
    if (socket.connected) {
      hideOverlay();
      return;
    }
    socket.connect();
  });

  socket.on('heartbeat', () => {
    socket.emit('heartbeat_ack', { t: Date.now() });
  });

  /* ================================================================ */
  /* Room state                                                       */
  /* ================================================================ */

  socket.on('room_state', (state) => {
    S.roomCode = state.roomCode;
    S.phase = state.phase;
    S.isHost = state.host;
    S.settings = state.settings;
    S.players = state.players;

    if (state.you) {
      S.myCode = state.you.code;
      S.isTagged = state.you.isTagged;
    }

    localStorage.setItem(LS_ROOM, state.roomCode);
    renderRoomScreen();
    renderGameHud();

    if (state.phase === 'lobby') {
      if (S.screen !== 'room' && S.screen !== 'home') setScreen('room');
      else if (S.screen === 'home') setScreen('room');
    }
  });

  socket.on('room_left', () => {
    S.roomCode = null;
    localStorage.removeItem(LS_ROOM);
    stopGps();
    resetChat();
    setScreen('home');
  });

  /* ================================================================ */
  /* Game lifecycle                                                   */
  /* ================================================================ */

  socket.on('game_started', (data) => {
    S.myCode = data.code;
    S.isTagged = data.isTagged;
    S.centeredOnce = false;
    S.userPanned = false;
    S.fittedPlay = false;
    S.lastSentLat = null;
    S.lastSentLng = null;
    S.lastLocationSentAt = 0;

    gpsFilter.reset();
    gpsHighAccuracy = true;
    gpsFailures = 0;

    clearPingMarkers();
    setScreen('game');
    applyStage(data);
    renderGameHud();
    startGps();
    toast('Five seconds — stand together in a circle.', data.isTagged ? 'zombie' : null);
  });

  socket.on('time_remaining', (data) => {
    applyStage(data);
    renderGameHud();
  });

  socket.on('ping_batch', (data) => {
    const pings = data.pings || [];
    S.pendingPings = pings;
    if (!S.pingRafPending) {
      S.pingRafPending = true;
      requestAnimationFrame(() => {
        S.pingRafPending = false;
        applyPings(S.pendingPings || []);
      });
    }
  });

  socket.on('player_tagged', (data) => {
    if (data.youAreZombie) {
      toast('You have been tagged — you are now a seeker.', 'zombie');
    } else {
      toast(`${data.byNickname} tagged ${data.nickname}.`, 'zombie');
    }
  });

  socket.on('game_over', (data) => {
    stopGps();
    clearPingMarkers();
    S.roomCode = null;
    S.phase = 'ended';
    localStorage.removeItem(LS_ROOM);

    el.overTitle.textContent = data.winner === 'zombies' ? 'SEEKERS WIN' : 'SURVIVORS WIN';
    el.overSub.textContent =
      data.winner === 'zombies'
        ? 'Every player was tagged.'
        : 'The round timer expired — the survivors made it.';

    el.overList.innerHTML = '';
    (data.players || [])
      .slice()
      .sort((a, b) => Number(b.isTagged) - Number(a.isTagged))
      .forEach((p) => {
        const li = document.createElement('li');
        li.innerHTML =
          `<span class="who"><span class="name">${escapeHtml(p.nickname)}</span></span>` +
          `<span class="state ${p.isTagged ? 'zombie' : 'alive'}">${p.isTagged ? 'Seeker' : 'Survived'}</span>`;
        el.overList.appendChild(li);
      });

    el.modalOver.hidden = false;
  });

  el.btnOverClose.addEventListener('click', () => {
    el.modalOver.hidden = true;
    S.phase = 'lobby';
    setScreen('home');
  });

  /* ================================================================ */
  /* Lobby rendering                                                  */
  /* ================================================================ */

  function renderRoomScreen() {
    el.roomCode.textContent = S.roomCode || '----';
    el.myCode.textContent = S.myCode || '---';

    el.myStatus.textContent = S.isTagged ? 'Seeker' : 'Survivor';
    el.myStatus.classList.toggle('zombie', !!S.isTagged);

    el.hostControls.hidden = !(S.isHost && S.phase === 'lobby');
    if (S.isHost) {
      const round = S.settings.roundMinutes;
      el.hostNoLimit.checked = round === null;
      el.hostRoundRange.disabled = round === null;
      if (round !== null) el.hostRoundRange.value = String(round);
      el.hostRoundVal.textContent = round === null ? 'No limit' : round + ' min';
      el.hostPingRange.value = String(S.settings.pingInterval);
      el.hostPingVal.textContent = S.settings.pingInterval + ' s';
      const wait = Number.isFinite(S.settings.seekerWait) ? S.settings.seekerWait : 30;
      el.hostWaitRange.value = String(wait);
      el.hostWaitVal.textContent = wait + ' s';
      const boundary = S.settings.boundary === 'none' ? 'none' : 'circle';
      el.hostBoundaryNone.classList.toggle('is-on', boundary === 'none');
      el.hostBoundaryCircle.classList.toggle('is-on', boundary === 'circle');
    }

    el.playerCount.textContent = String(S.players.length);
    el.playerList.innerHTML = '';
    for (const p of S.players) {
      const li = document.createElement('li');
      const badges =
        (p.isHost ? '<span class="tag-host">Host</span>' : '') +
        (p.sessionId === sessionId ? '<span class="tag-you">You</span>' : '');
      const state = !p.connected
        ? '<span class="state offline">Offline</span>'
        : p.isTagged
        ? '<span class="state zombie">Seeker</span>'
        : '<span class="state alive">Alive</span>';
      li.innerHTML = `<span class="who"><span class="name">${escapeHtml(p.nickname)}</span>${badges}</span>${state}`;
      el.playerList.appendChild(li);
    }
  }

  /* ================================================================ */
  /* In-game HUD                                                      */
  /* ================================================================ */

  function renderGameHud() {
    if (!S.myCode) return;

    el.roleBadge.textContent = S.isTagged ? 'SEEKER' : 'SURVIVOR';
    el.roleBadge.classList.toggle('zombie', !!S.isTagged);

    el.hudCode.textContent = S.myCode;
    el.hudCode.classList.toggle('greyed', !!S.isTagged);

    el.btnTag.hidden = !S.isTagged || S.stage !== 'hunt';
  }

  function applyStage(data) {
    if (!data) return;
    if (data.stage) S.stage = data.stage;
    if (data.boundary) S.boundary = data.boundary;
    if (Number.isFinite(data.radiusM)) S.radiusM = data.radiusM;
    if (data.center && Number.isFinite(data.center.lat)) S.center = data.center;

    const preHunt = S.stage === 'gather' || S.stage === 'hiding';
    S.timerSync = {
      mode: S.stage || 'hunt',
      msLeft: preHunt ? data.msUntilHunt : data.msLeft,
      at: performance.now(),
    };
    drawPlayCircle();
    updateBoundaryWarning();
  }

  function timerLoop() {
    if (S.screen !== 'game') {
      window.__timerLoop = false;
      return;
    }
    if (S.timerSync) {
      const left =
        S.timerSync.msLeft == null
          ? null
          : Math.max(0, S.timerSync.msLeft - (performance.now() - S.timerSync.at));
      if (S.timerSync.mode === 'gather') {
        el.timer.textContent = formatClock(left || 0);
        el.phaseLabel.textContent = 'Form a circle';
      } else if (S.timerSync.mode === 'hiding') {
        el.timer.textContent = formatClock(left || 0);
        el.phaseLabel.textContent = S.isTagged ? 'You are waiting' : 'Seeker is waiting';
      } else if (left == null) {
        el.timer.textContent = 'NO LIMIT';
        el.phaseLabel.textContent = 'Hunt';
      } else {
        el.timer.textContent = formatClock(left);
        el.phaseLabel.textContent = 'Hunt';
      }
    } else {
      el.timer.textContent = '--:--';
      el.phaseLabel.textContent = 'Get ready';
    }
    requestAnimationFrame(timerLoop);
  }

  /* ================================================================ */
  /* Map                                                              */
  /* ================================================================ */

  const BASEMAPS = {
    map: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      attribution:
        'Tiles &copy; Esri &mdash; Sources: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri Thailand, TomTom',
    },
    satellite: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution:
        'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
  };

  function syncMapStyleButtons() {
    const satellite = S.mapStyle === 'satellite';
    el.btnMapPlain.classList.toggle('is-on', !satellite);
    el.btnMapSat.classList.toggle('is-on', satellite);
    el.btnMapPlain.setAttribute('aria-pressed', satellite ? 'false' : 'true');
    el.btnMapSat.setAttribute('aria-pressed', satellite ? 'true' : 'false');
  }

  function applyMapStyle(style) {
    if (!BASEMAPS[style]) style = 'satellite';
    S.mapStyle = style;
    try {
      localStorage.setItem(LS_MAP_STYLE, style);
    } catch (_) { /* ignore */ }
    syncMapStyleButtons();
    if (!S.map) return;
    if (S.baseLayer) S.map.removeLayer(S.baseLayer);
    const spec = BASEMAPS[style];
    S.baseLayer = L.tileLayer(spec.url, {
      attribution: spec.attribution,
      maxZoom: 19,
    }).addTo(S.map);
    S.baseLayer.bringToBack();
  }

  function ensureMap() {
    if (S.mapReady) return;
    S.mapReady = true;

    S.map = L.map(el.map, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
      zoomSnap: 0.25,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 70,
      minZoom: 3,
      maxZoom: 19,
    }).setView([20, 0], 2);

    // One padded canvas renderer for every vector layer.
    S.vectorRenderer = L.canvas({ padding: 0.5 });

    applyMapStyle(S.mapStyle);

    S.map.on('dragstart zoomstart', () => { S.userPanned = true; });

    window.addEventListener('resize', () => {
      if (S.map) S.map.invalidateSize();
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 200);
    });
  }

  try {
    const savedMap = localStorage.getItem(LS_MAP_STYLE);
    if (savedMap === 'map' || savedMap === 'satellite') S.mapStyle = savedMap;
  } catch (_) { /* ignore */ }
  syncMapStyleButtons();
  el.btnMapPlain.addEventListener('click', () => applyMapStyle('map'));
  el.btnMapSat.addEventListener('click', () => applyMapStyle('satellite'));

  /* --- Self marker (DOM, not canvas) --- */

  function ensureSelfMarker(lat, lng) {
    if (!S.map || S.selfMarker) return;
    const icon = L.divIcon({
      className: 'self-marker-wrap',
      html: '<div class="self-marker-ring"></div><div class="self-marker-dot"></div>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    S.selfMarker = L.marker([lat, lng], {
      icon,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(S.map);
  }

  function updateSelfMarker(lat, lng, accuracy) {
    if (!S.map) return;
    ensureSelfMarker(lat, lng);
    S.selfMarker.setLatLng([lat, lng]);

    if (Number.isFinite(accuracy) && accuracy > 12) {
      if (!S.accuracyCircle) {
        S.accuracyCircle = L.circle([lat, lng], {
          radius: accuracy,
          renderer: S.vectorRenderer,
          color: '#7fe7ff',
          weight: 1,
          fillColor: '#7fe7ff',
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(S.map);
      } else {
        S.accuracyCircle.setLatLng([lat, lng]);
        S.accuracyCircle.setRadius(accuracy);
      }
    } else if (S.accuracyCircle) {
      S.map.removeLayer(S.accuracyCircle);
      S.accuracyCircle = null;
    }

    if (!S.centeredOnce) {
      S.centeredOnce = true;
      if (!S.center) S.map.setView([lat, lng], 16);
    }
    updateBoundaryWarning();
  }

  /* --- Play circle --- */

  function drawPlayCircle() {
    if (!S.map) return;
    const show = S.boundary === 'circle' && S.center;
    if (!show) {
      if (S.playCircle) {
        S.map.removeLayer(S.playCircle);
        S.playCircle = null;
      }
      return;
    }
    if (!S.playCircle) {
      S.playCircle = L.circle([S.center.lat, S.center.lng], {
        radius: S.radiusM,
        renderer: S.vectorRenderer,
        color: '#7fe7ff',
        weight: 2,
        dashArray: '6 8',
        fillColor: '#7fe7ff',
        fillOpacity: 0.05,
        interactive: false,
      }).addTo(S.map);
    } else {
      S.playCircle.setLatLng([S.center.lat, S.center.lng]);
      S.playCircle.setRadius(S.radiusM);
    }
    if (!S.fittedPlay) fitPlayArea(false);
  }

  function fitPlayArea(force) {
    if (!S.map) return;
    if (S.playCircle) {
      S.fittedPlay = true;
      if (force) S.userPanned = false;
      S.map.fitBounds(S.playCircle.getBounds(), { padding: [72, 72], maxZoom: 16 });
      return;
    }
    if (force && S.myPos) S.map.setView([S.myPos.lat, S.myPos.lng], 15);
  }

  function updateBoundaryWarning() {
    if (!el.boundaryBanner) return;
    const outside =
      S.screen === 'game' &&
      S.boundary === 'circle' &&
      S.center &&
      S.myPos &&
      haversine(S.myPos.lat, S.myPos.lng, S.center.lat, S.center.lng) > S.radiusM;
    el.boundaryBanner.hidden = !outside;
  }

  /* --- Ping rendering --- */

  function popupHtml(ping) {
    const dist = S.myPos
      ? haversine(S.myPos.lat, S.myPos.lng, ping.lat, ping.lng)
      : null;

    const theirAcc = Number.isFinite(ping.accuracy) ? ping.accuracy : null;
    const myAcc =
      S.myPos && Number.isFinite(S.myPos.accuracy) ? S.myPos.accuracy : null;

    const combined =
      theirAcc !== null && myAcc !== null
        ? Math.sqrt(theirAcc * theirAcc + myAcc * myAcc)
        : null;

    return (
      '<div class="popup">' +
      `<strong>${escapeHtml(ping.nickname)}</strong>` +
      `<div class="popup-dist">${dist === null ? 'Distance unknown' : formatDistance(dist)}` +
      (combined !== null
        ? ` <span class="popup-uncertainty">±${Math.round(combined)}m</span>`
        : '') +
      '</div>' +
      `<div class="popup-meta">${ping.role === 'zombie' ? 'Seeker' : 'Survivor'} · pinged ${timeAgo(ping.ts)}</div>` +
      `<div class="popup-meta popup-acc">Their GPS ${
        theirAcc !== null ? '±' + Math.round(theirAcc) + 'm' : '?'
      }${myAcc !== null ? ' · Yours ±' + Math.round(myAcc) + 'm' : ''}</div>` +
      (ping.stale
        ? `<div class="popup-stale">Stale fix — best available. Don't trust this marker if their GPS is poor.</div>`
        : '') +
      '</div>'
    );
  }

  function applyPings(pings) {
    if (!S.map) return;
    const seen = new Set();

    for (const ping of pings) {
      seen.add(ping.id);
      const existing = S.pingMarkers.get(ping.id);
      const stale = !!ping.stale;

      if (
        existing &&
        existing.ts === ping.ts &&
        existing.lat === ping.lat &&
        existing.lng === ping.lng &&
        existing.stale === stale &&
        existing.role === ping.role
      ) {
        continue;
      }

      if (existing) {
        existing.marker.setLatLng([ping.lat, ping.lng]);
        if (existing.role !== ping.role || existing.stale !== stale) {
          existing.marker.setIcon(pingIcon(ping));
        }
        if (Number.isFinite(ping.accuracy) && ping.accuracy > 0) {
          if (!existing.accCircle) {
            existing.accCircle = accuracyCircleFor(ping);
          } else {
            existing.accCircle.setLatLng([ping.lat, ping.lng]);
            existing.accCircle.setRadius(ping.accuracy);
          }
        }
        existing.marker.bindPopup(() => popupHtml(ping));
        existing.lat = ping.lat;
        existing.lng = ping.lng;
        existing.ts = ping.ts;
        existing.stale = stale;
        existing.role = ping.role;
        existing.nickname = ping.nickname;
        continue;
      }

      const marker = L.marker([ping.lat, ping.lng], {
        icon: pingIcon(ping),
        keyboard: false,
      }).addTo(S.map);
      marker.bindPopup(() => popupHtml(ping));
      const accCircle =
        Number.isFinite(ping.accuracy) && ping.accuracy > 0
          ? accuracyCircleFor(ping)
          : null;

      S.pingMarkers.set(ping.id, {
        marker,
        accCircle,
        lat: ping.lat,
        lng: ping.lng,
        ts: ping.ts,
        stale,
        nickname: ping.nickname,
        role: ping.role,
      });
    }

    for (const [id, entry] of S.pingMarkers) {
      if (!seen.has(id)) {
        S.map.removeLayer(entry.marker);
        if (entry.accCircle) S.map.removeLayer(entry.accCircle);
        S.pingMarkers.delete(id);
      }
    }
  }

  function pingIcon(ping) {
    return L.divIcon({
      className: 'ping-icon-wrap',
      html:
        `<div class="ping-marker ${ping.role}${ping.stale ? ' stale' : ''}">` +
        '<span class="pulse"></span><span class="dot"></span>' +
        '</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -12],
    });
  }

  function accuracyCircleFor(ping) {
    const color = ping.role === 'zombie' ? '#ff4d5e' : '#3ddc84';
    return L.circle([ping.lat, ping.lng], {
      radius: ping.accuracy,
      renderer: S.vectorRenderer,
      color,
      weight: 1,
      dashArray: '4 4',
      fillColor: color,
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(S.map);
  }

  function clearPingMarkers() {
    if (S.map) {
      for (const entry of S.pingMarkers.values()) {
        S.map.removeLayer(entry.marker);
        if (entry.accCircle) S.map.removeLayer(entry.accCircle);
      }
    }
    S.pingMarkers.clear();
  }

  el.btnRecenter.addEventListener('click', () => {
    if (S.map && S.myPos) {
      S.userPanned = false;
      S.map.setView([S.myPos.lat, S.myPos.lng], S.map.getZoom());
    }
  });
  el.btnZoomIn.addEventListener('click', () => S.map && S.map.zoomIn());
  el.btnZoomOut.addEventListener('click', () => S.map && S.map.zoomOut());
  el.btnFit.addEventListener('click', () => fitPlayArea(true));

  /* ================================================================ */
  /* GPS runtime                                                      */
  /* ================================================================ */

  function startGps() {
    if (S.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      showGpsBanner('This device/browser does not support geolocation.');
      return;
    }

    const opts = gpsHighAccuracy ? GEO_OPTS_HIGH : GEO_OPTS_LOW;
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, opts);
    S.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, opts);
  }

  function stopGps() {
    if (S.watchId !== null) {
      navigator.geolocation.clearWatch(S.watchId);
      S.watchId = null;
    }
    if (S.gpsRetryTimer) {
      clearTimeout(S.gpsRetryTimer);
      S.gpsRetryTimer = null;
    }
  }

  function onPosition(pos) {
    const rawLat = pos.coords.latitude;
    const rawLng = pos.coords.longitude;
    const rawAcc = pos.coords.accuracy;
    const ts = Number.isFinite(pos.timestamp) ? pos.timestamp : Date.now();

    const result = gpsFilter.process(rawLat, rawLng, rawAcc, ts);

    if (!result.accepted) {
      if (result.reason === 'poor_accuracy') {
        S.gpsOk = false;
        showGpsBanner(
          `GPS accuracy is \u00b1${Math.round(result.accuracy)}m — move to open sky.`
        );
        updateGpsIndicator(result.accuracy, false);
      }
      return;
    }

    gpsFailures = 0;
    S.gpsOk = true;
    hideGpsBanner();
    S.myPos = {
      lat: result.lat,
      lng: result.lng,
      accuracy: result.accuracy,
      speed: result.speed,
    };

    updateSelfMarker(result.lat, result.lng, result.accuracy);
    updateGpsIndicator(result.accuracy, true);

    if (result.acceptedCount < GPS_WARMUP_FIXES) return;

    const now = performance.now();
    let shouldSend = false;

    if (S.lastSentLat == null || S.lastSentLng == null) {
      shouldSend = true;
    } else if (
      haversine(S.lastSentLat, S.lastSentLng, result.lat, result.lng) >= GPS_MIN_SEND_M
    ) {
      shouldSend = true;
    }

    if (now - S.lastLocationSentAt >= GPS_HEARTBEAT_MS) shouldSend = true;
    if (now - S.lastLocationSentAt < GPS_MIN_SEND_GAP_MS) shouldSend = false;

    if (!shouldSend) return;

    S.lastLocationSentAt = now;
    S.lastSentLat = result.lat;
    S.lastSentLng = result.lng;
    socket.emit('location_update', {
      lat: result.lat,
      lng: result.lng,
      accuracy: result.accuracy,
      speed: result.speed,
    });
  }

  function updateGpsIndicator(accuracy, ok) {
    if (!el.hudGps) return;
    if (!Number.isFinite(accuracy)) {
      el.hudGps.textContent = 'GPS ?';
      el.hudGps.className = 'hud-gps';
      return;
    }
    const a = Math.round(accuracy);
    el.hudGps.textContent = `GPS \u00b1${a}m${ok ? '' : ' (poor)'}`;
    el.hudGps.className = 'hud-gps ' + (a > 60 ? 'poor' : a > 25 ? 'fair' : 'good');
  }

  function onGpsError(err) {
    S.gpsOk = false;

    let message =
      'Location unavailable. Check that GPS is enabled and you have a clear view of the sky.';
    if (err && err.code === 1) {
      message =
        'Location permission denied. Allow location access for this site in your browser settings.';
    }

    const isIosStandalone =
      window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    if (isIosStandalone && err && err.code === 1) {
      message =
        'If location is not working, please open this site in Safari instead of the home screen app, and allow location access.';
    }

    showGpsBanner(message);

    if (err && (err.code === 2 || err.code === 3)) {
      gpsFailures++;
      if (gpsFailures >= 2 && gpsHighAccuracy) {
        gpsHighAccuracy = false;
        toast('Switching to standard GPS mode.', null);
      }
    }

    if (S.watchId !== null) {
      navigator.geolocation.clearWatch(S.watchId);
      S.watchId = null;
    }
    if (S.gpsRetryTimer) clearTimeout(S.gpsRetryTimer);
    S.gpsRetryTimer = setTimeout(() => {
      S.gpsRetryTimer = null;
      startGps();
    }, GPS_RETRY_MS);
  }

  function showGpsBanner(message) {
    el.gpsBanner.textContent = message;
    el.gpsBanner.hidden = false;
  }

  function hideGpsBanner() {
    el.gpsBanner.hidden = true;
  }

  function acquireWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    if (S.wakeLock) return;
    navigator.wakeLock
      .request('screen')
      .then((lock) => {
        S.wakeLock = lock;
        lock.addEventListener('release', () => {
          if (S.wakeLock === lock) S.wakeLock = null;
        });
      })
      .catch(() => {});
  }

  function releaseWakeLock() {
    const lock = S.wakeLock;
    S.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (S.screen !== 'game') return;
    if (document.visibilityState === 'hidden') {
      el.hiddenBanner.hidden = false;
      return;
    }
    el.hiddenBanner.hidden = true;
    if (S.gpsOk) hideGpsBanner();
    stopGps();
    startGps();
    acquireWakeLock();
  });

  document.addEventListener('pointerdown', () => {
    if (S.screen === 'game') acquireWakeLock();
  });

  /* ================================================================ */
  /* Home screen wiring                                               */
  /* ================================================================ */

  const savedNick = localStorage.getItem(LS_NICK);
  if (savedNick) el.nickname.value = savedNick;

  try {
    const savedSettings = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (savedSettings) {
      if (Number.isFinite(savedSettings.roundMinutes)) {
        el.roundRange.value = String(savedSettings.roundMinutes);
      }
      if (Number.isFinite(savedSettings.pingInterval)) {
        el.pingRange.value = String(savedSettings.pingInterval);
      }
      if (Number.isFinite(savedSettings.seekerWait)) {
        el.waitRange.value = String(savedSettings.seekerWait);
      }
      el.noLimit.checked = !!savedSettings.noLimit;
      setBoundaryButtons(
        el.boundaryNone,
        el.boundaryCircle,
        savedSettings.boundary === 'none' ? 'none' : 'circle'
      );
    }
  } catch (_) { /* ignore */ }

  function syncHomeSettingsLabels() {
    const noLimit = el.noLimit.checked;
    el.roundRange.disabled = noLimit;
    el.roundVal.textContent = noLimit ? 'No limit' : el.roundRange.value + ' min';
    el.pingVal.textContent = el.pingRange.value + ' s';
    el.waitVal.textContent = el.waitRange.value + ' s';
  }
  function setBoundaryButtons(noneBtn, circleBtn, boundary) {
    const circle = boundary !== 'none';
    noneBtn.classList.toggle('is-on', !circle);
    circleBtn.classList.toggle('is-on', circle);
  }
  function selectedBoundary(noneBtn) {
    return noneBtn.classList.contains('is-on') ? 'none' : 'circle';
  }
  syncHomeSettingsLabels();

  el.roundRange.addEventListener('input', syncHomeSettingsLabels);
  el.noLimit.addEventListener('change', syncHomeSettingsLabels);
  el.pingRange.addEventListener('input', syncHomeSettingsLabels);
  el.waitRange.addEventListener('input', syncHomeSettingsLabels);
  el.boundaryNone.addEventListener('click', () => setBoundaryButtons(el.boundaryNone, el.boundaryCircle, 'none'));
  el.boundaryCircle.addEventListener('click', () => setBoundaryButtons(el.boundaryNone, el.boundaryCircle, 'circle'));

  el.btnShowCreate.addEventListener('click', () => {
    el.createPanel.hidden = !el.createPanel.hidden;
    if (!el.createPanel.hidden) el.joinPanel.hidden = true;
  });

  el.btnShowJoin.addEventListener('click', () => {
    el.joinPanel.hidden = !el.joinPanel.hidden;
    if (!el.joinPanel.hidden) {
      el.createPanel.hidden = true;
      el.roomInput.focus();
    }
  });

  el.roomInput.addEventListener('input', () => {
    el.roomInput.value = el.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  function currentNickname() {
    const nick = el.nickname.value.trim().slice(0, 20);
    if (nick) localStorage.setItem(LS_NICK, nick);
    return nick;
  }

  el.btnCreate.addEventListener('click', () => {
    const nickname = currentNickname();
    if (!nickname) {
      toast('Please enter a nickname.', 'error');
      el.nickname.focus();
      return;
    }
    const payload = {
      sessionId,
      nickname,
      roundMinutes: Number(el.roundRange.value),
      pingInterval: Number(el.pingRange.value),
      seekerWait: Number(el.waitRange.value),
      boundary: selectedBoundary(el.boundaryNone),
      noLimit: el.noLimit.checked,
    };
    localStorage.setItem(
      LS_SETTINGS,
      JSON.stringify({
        roundMinutes: payload.roundMinutes,
        pingInterval: payload.pingInterval,
        seekerWait: payload.seekerWait,
        boundary: payload.boundary,
        noLimit: payload.noLimit,
      })
    );

    el.btnCreate.disabled = true;
    socket.emit('create_room', payload, (res) => {
      el.btnCreate.disabled = false;
      if (!res || !res.ok) {
        toast((res && res.error) || 'Could not create the room.', 'error');
        return;
      }
      S.roomCode = res.roomCode;
      localStorage.setItem(LS_ROOM, res.roomCode);
      el.createPanel.hidden = true;
      setScreen('room');
    });
  });

  el.btnJoin.addEventListener('click', () => {
    const nickname = currentNickname();
    const roomCode = el.roomInput.value.trim().toUpperCase();
    if (!nickname) {
      toast('Please enter a nickname.', 'error');
      el.nickname.focus();
      return;
    }
    if (roomCode.length !== 4) {
      toast('Room codes are 4 characters.', 'error');
      return;
    }

    el.btnJoin.disabled = true;
    socket.emit('join_room', { sessionId, nickname, roomCode }, (res) => {
      el.btnJoin.disabled = false;
      if (!res || !res.ok) {
        toast((res && res.error) || 'Could not join the room.', 'error');
        return;
      }
      S.roomCode = res.roomCode;
      localStorage.setItem(LS_ROOM, res.roomCode);
      el.joinPanel.hidden = true;
      setScreen('room');
    });
  });

  /* ================================================================ */
  /* Room screen wiring                                               */
  /* ================================================================ */

  el.btnLeave.addEventListener('click', () => {
    socket.emit('leave_room');
  });

  function pushHostSettings() {
    const noLimit = el.hostNoLimit.checked;
    socket.emit(
      'update_settings',
      {
        roundMinutes: Number(el.hostRoundRange.value),
        pingInterval: Number(el.hostPingRange.value),
        seekerWait: Number(el.hostWaitRange.value),
        boundary: selectedBoundary(el.hostBoundaryNone),
        noLimit,
      },
      (res) => {
        if (res && !res.ok) toast(res.error, 'error');
      }
    );
  }

  el.hostRoundRange.addEventListener('input', () => {
    el.hostRoundVal.textContent = el.hostRoundRange.value + ' min';
  });
  el.hostRoundRange.addEventListener('change', pushHostSettings);

  el.hostNoLimit.addEventListener('change', () => {
    el.hostRoundRange.disabled = el.hostNoLimit.checked;
    el.hostRoundVal.textContent = el.hostNoLimit.checked ? 'No limit' : el.hostRoundRange.value + ' min';
    pushHostSettings();
  });

  el.hostPingRange.addEventListener('input', () => {
    el.hostPingVal.textContent = el.hostPingRange.value + ' s';
  });
  el.hostPingRange.addEventListener('change', pushHostSettings);

  el.hostWaitRange.addEventListener('input', () => {
    el.hostWaitVal.textContent = el.hostWaitRange.value + ' s';
  });
  el.hostWaitRange.addEventListener('change', pushHostSettings);
  el.hostBoundaryNone.addEventListener('click', () => {
    setBoundaryButtons(el.hostBoundaryNone, el.hostBoundaryCircle, 'none');
    pushHostSettings();
  });
  el.hostBoundaryCircle.addEventListener('click', () => {
    setBoundaryButtons(el.hostBoundaryNone, el.hostBoundaryCircle, 'circle');
    pushHostSettings();
  });

  el.btnStart.addEventListener('click', () => {
    el.btnStart.disabled = true;
    socket.emit('start_game', {}, (res) => {
      el.btnStart.disabled = false;
      if (res && !res.ok) toast(res.error, 'error');
    });
  });

  /* ================================================================ */
  /* Tag flow                                                         */
  /* ================================================================ */

  el.btnTag.addEventListener('click', () => {
    el.tagInput.value = '';
    el.tagError.hidden = true;
    el.modalTag.hidden = false;
    setTimeout(() => el.tagInput.focus(), 60);
  });

  el.btnTagCancel.addEventListener('click', () => {
    el.modalTag.hidden = true;
  });

  el.tagInput.addEventListener('input', () => {
    el.tagInput.value = el.tagInput.value.replace(/\D/g, '').slice(0, 3);
    el.tagError.hidden = true;
    if (el.tagInput.value.length === 3) submitTag();
  });

  el.tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitTag();
  });

  el.btnTagSubmit.addEventListener('click', submitTag);

  let tagPending = false;

  function submitTag() {
    if (tagPending) return;
    const code = el.tagInput.value.trim();
    if (!/^\d{3}$/.test(code)) {
      el.tagError.textContent = 'Enter a 3-digit code.';
      el.tagError.hidden = false;
      return;
    }

    tagPending = true;
    el.btnTagSubmit.disabled = true;

    socket.emit('submit_tag', { code }, (res) => {
      tagPending = false;
      el.btnTagSubmit.disabled = false;

      if (!res || !res.ok) {
        el.tagError.textContent = (res && res.error) || 'Tag failed.';
        el.tagError.hidden = false;
        el.tagInput.select();
        return;
      }

      el.modalTag.hidden = true;
      el.tagInput.value = '';
      toast(`Tagged ${res.tagged}!`, 'zombie');
      if (navigator.vibrate) navigator.vibrate(60);
    });
  }

  /* ================================================================ */
  /* Players modal                                                    */
  /* ================================================================ */

  el.btnPlayers.addEventListener('click', () => {
    el.modalPlayerList.innerHTML = '';
    const sorted = S.players.slice().sort((a, b) => {
      if (a.isTagged !== b.isTagged) return a.isTagged ? 1 : -1;
      return a.nickname.localeCompare(b.nickname);
    });
    for (const p of sorted) {
      const li = document.createElement('li');
      const you = p.sessionId === sessionId ? '<span class="tag-you">You</span>' : '';
      const state = !p.connected
        ? '<span class="state offline">Offline</span>'
        : p.isTagged
        ? '<span class="state zombie">Seeker</span>'
        : '<span class="state alive">Alive</span>';
      li.innerHTML = `<span class="who"><span class="name">${escapeHtml(p.nickname)}</span>${you}</span>${state}`;
      el.modalPlayerList.appendChild(li);
    }
    el.modalPlayers.hidden = false;
  });

  el.btnPlayersClose.addEventListener('click', () => {
    el.modalPlayers.hidden = true;
  });

  /* ================================================================ */
  /* PWA install + iOS hint                                           */
  /* ================================================================ */

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const isStandalone =
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  if (isIos && !isStandalone) el.iosHint.hidden = false;

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!isIos) el.iosHint.hidden = false;
    el.iosHint.innerHTML = '<strong>Install:</strong> tap “Add to Home Screen”.';
  });

  el.iosHint.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch (_) { /* ignore */ }
    deferredPrompt = null;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* best-effort */ });
    });
  }

  /* ================================================================ */
  /* Chat                                                             */
  /* ================================================================ */

  function updateChatBadge() {
    const label = S.chatUnread > 0 ? 'Chat ' + S.chatUnread : 'Chat';
    el.btnChat.textContent = label;
    el.btnRoomChat.textContent = label;
  }

  function setChatOpen(open) {
    S.chatOpen = open;
    el.chatSheet.hidden = !open;
    if (open) {
      S.chatUnread = 0;
      updateChatBadge();
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
      setTimeout(() => el.chatInput.focus(), 40);
    }
  }

  function appendChat(msg) {
    const row = document.createElement('div');
    row.className =
      'chat-msg' +
      (msg.sessionId === sessionId ? ' mine' : '') +
      (msg.role === 'zombie' ? ' zombie' : '');
    row.innerHTML =
      `<span class="chat-name">${escapeHtml(msg.nickname)}</span>` +
      `<span class="chat-text">${escapeHtml(msg.text)}</span>`;
    el.chatLog.appendChild(row);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function renderChatHistory(messages) {
    el.chatLog.innerHTML = '';
    if (!messages || !messages.length) {
      el.chatLog.innerHTML =
        '<div class="chat-empty">No messages yet. Everyone can read this, including the seeker.</div>';
      return;
    }
    for (const msg of messages) appendChat(msg);
  }

  function resetChat() {
    S.chatUnread = 0;
    updateChatBadge();
    setChatOpen(false);
    renderChatHistory([]);
  }

  socket.on('chat_history', (data) => {
    renderChatHistory((data && data.messages) || []);
  });

  socket.on('chat_message', (msg) => {
    if (!msg) return;
    const empty = el.chatLog.querySelector('.chat-empty');
    if (empty) empty.remove();
    appendChat(msg);
    if (!S.chatOpen && msg.sessionId !== sessionId) {
      S.chatUnread += 1;
      updateChatBadge();
    }
  });

  el.btnChat.addEventListener('click', () => setChatOpen(!S.chatOpen));
  el.btnRoomChat.addEventListener('click', () => setChatOpen(!S.chatOpen));
  el.btnChatClose.addEventListener('click', () => setChatOpen(false));
  el.chatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = el.chatInput.value.trim();
    if (!text) return;
    el.chatInput.value = '';
    socket.emit('chat', { text }, (res) => {
      if (res && res.ok === false && res.error) toast(res.error, 'error');
    });
  });

  /* ================================================================ */
  /* iOS slider touch fix                                             */
  /* ================================================================ */

  document.addEventListener('touchstart', () => {}, { passive: true });

  if (isIos) {
    document.querySelectorAll('input[type="range"]').forEach((slider) => {
      slider.addEventListener(
        'touchend',
        (e) => {
          const rect = slider.getBoundingClientRect();
          const touch = e.changedTouches[0];
          const val =
            (touch.pageX - rect.left) / (rect.right - rect.left) *
              (Number(slider.max) - Number(slider.min)) +
            Number(slider.min);
          const step = Number(slider.step) || 1;
          const stepped = Math.round(val / step) * step;
          slider.value = String(Math.min(Number(slider.max), Math.max(Number(slider.min), stepped)));
          slider.dispatchEvent(new Event('change'));
        },
        { passive: true }
      );
    });
  }

  /* ================================================================ */
  /* Boot                                                             */
  /* ================================================================ */

  setScreen('home');
  showOverlay(
    'Connecting to server…',
    'This may take up to a minute on first launch while the free server wakes up.'
  );

  fetch('/wake', { cache: 'no-store' }).catch(() => {});
})();