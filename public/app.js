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

  const GEO_OPTS = {
    enableHighAccuracy: true, // use the GPS radio, not Wi-Fi/cell
    maximumAge: 0,            // force a fresh fix
    timeout: 15000,
  };
  const GPS_RETRY_MS = 10000;
  const LOCATION_SEND_MS = 1000; // client-side throttle: max 1 update/sec

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
    const mins = Math.round(secs / 60);
    return mins + 'm ago';
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
    wakeLock: null,
    selfMarker: null,
    accuracyCircle: null,
    playCircle: null,
    pingMarkers: new Map(), // id -> { marker, lat, lng, ts, nickname, role }
    centeredOnce: false,
    userPanned: false,
    fittedPlay: false,

    timerSync: null,
    watchId: null,
    gpsRetryTimer: null,
    lastLocationSentAt: 0,
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
    btnNorth: $('btn-north'),
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
      // Leaflet needs a tick after the container becomes visible.
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

  /* --- Render keep-alive: reply to heartbeats so the service stays up --- */
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
    console.log(`[ping] received ${pings.length} ping(s) from server`);
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

    // Host controls
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

    // Player list (names only — codes are never broadcast)
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
    } catch (_) {
      /* ignore */
    }
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
      rotate: true,
      bearing: 0,
      touchRotate: true,
      shiftKeyRotate: true,
      touchZoom: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      dragging: true,
    }).setView([20, 0], 2);

    applyMapStyle(S.mapStyle);

    S.map.on('dragstart zoomstart rotatestart', () => {
      S.userPanned = true;
    });
  }

  try {
    const savedMap = localStorage.getItem(LS_MAP_STYLE);
    if (savedMap === 'map' || savedMap === 'satellite') S.mapStyle = savedMap;
  } catch (_) {
    /* ignore */
  }
  syncMapStyleButtons();
  el.btnMapPlain.addEventListener('click', () => applyMapStyle('map'));
  el.btnMapSat.addEventListener('click', () => applyMapStyle('satellite'));

  function updateSelfMarker(lat, lng, accuracy) {
    if (!S.map) return;
    if (!S.selfMarker) {
      S.selfMarker = L.circleMarker([lat, lng], {
        radius: 7,
        color: '#7fe7ff',
        weight: 3,
        fillColor: '#0b0f14',
        fillOpacity: 1,
      }).addTo(S.map);
    } else {
      S.selfMarker.setLatLng([lat, lng]);
    }

    if (Number.isFinite(accuracy) && accuracy > 0) {
      if (!S.accuracyCircle) {
        S.accuracyCircle = L.circle([lat, lng], {
          radius: accuracy,
          color: '#7fe7ff',
          weight: 1,
          fillColor: '#7fe7ff',
          fillOpacity: 0.08,
        }).addTo(S.map);
      } else {
        S.accuracyCircle.setLatLng([lat, lng]);
        S.accuracyCircle.setRadius(accuracy);
      }
    }

    if (!S.centeredOnce) {
      S.centeredOnce = true;
      if (!S.center) S.map.setView([lat, lng], 15);
    }
    updateBoundaryWarning();
  }

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

  /**
   * Pings are dropped in as brand-new markers (never slid to the new position —
   * that would imply continuous tracking).
   */
  function applyPings(pings) {
    if (!S.map) return;
    const seen = new Set();

    if (pings.length > 0) {
      console.log(
        `[ping] applying ${pings.length}: ` +
          pings
            .map(
              (p) =>
                `${p.nickname}[${p.role}]±${p.accuracy ? Math.round(p.accuracy) + 'm' : '?'}${p.stale ? ' stale' : ''}`
            )
            .join(', ')
      );
    }

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

      const marker = L.marker([ping.lat, ping.lng], { icon: pingIcon(ping), keyboard: false }).addTo(S.map);
      marker.bindPopup(() => popupHtml(ping));
      const accCircle =
        Number.isFinite(ping.accuracy) && ping.accuracy > 0 ? accuracyCircleFor(ping) : null;

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

    // Drop a marker only when this player is no longer visible (tagged onto your team, or left).
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
  el.btnNorth.addEventListener('click', () => {
    if (S.map && typeof S.map.setBearing === 'function') S.map.setBearing(0);
  });
  el.btnFit.addEventListener('click', () => fitPlayArea(true));

  /* ================================================================ */
  /* GPS                                                              */
  /* ================================================================ */

  function startGps() {
    if (S.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      showGpsBanner('This device/browser does not support geolocation.');
      return;
    }

    // A one-shot high-accuracy request wakes the GPS radio on iOS before the watch starts.
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, GEO_OPTS);
    S.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, GEO_OPTS);
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
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    S.myPos = { lat, lng, accuracy };
    S.gpsOk = true;
    hideGpsBanner();
    updateSelfMarker(lat, lng, accuracy);
    updateGpsIndicator(accuracy);

    const accStr = Number.isFinite(accuracy) ? `${Math.round(accuracy)}m` : '?';
    console.log(`[gps] lat=${lat.toFixed(6)} lng=${lng.toFixed(6)} acc=${accStr}`);
    if (Number.isFinite(accuracy) && accuracy > 100) {
      console.warn(`[gps] POOR ACCURACY ${accStr} \u2014 pings will be off by roughly this much`);
    }

    const now = performance.now();
    if (now - S.lastLocationSentAt >= LOCATION_SEND_MS) {
      S.lastLocationSentAt = now;
      socket.emit('location_update', { lat, lng, accuracy });
    }
  }

  function updateGpsIndicator(accuracy) {
    if (!el.hudGps) return;
    if (!Number.isFinite(accuracy)) {
      el.hudGps.textContent = 'GPS ?';
      el.hudGps.className = 'hud-gps';
      return;
    }
    const a = Math.round(accuracy);
    el.hudGps.textContent = `GPS \u00b1${a}m`;
    el.hudGps.className =
      'hud-gps ' + (a > 100 ? 'poor' : a > 30 ? 'fair' : 'good');
  }

  function onGpsError(err) {
    S.gpsOk = false;

    let message = 'Location unavailable. Check that GPS is enabled and you have a clear view of the sky.';
    if (err && err.code === 1) {
      message = 'Location permission denied. Allow location access for this site in your browser settings.';
    }

    const isIosStandalone =
      window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    if (isIosStandalone && err && err.code === 1) {
      message =
        'If location is not working, please open this site in Safari instead of the home screen app, and allow location access.';
    }

    showGpsBanner(message);

    // Retry every 10 seconds.
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

  /* --- Foreground-only GPS (iOS suspends the watch while the page is hidden) --- */
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
  } catch (_) {
    /* ignore */
  }

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
    } catch (_) {
      /* ignore */
    }
    deferredPrompt = null;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* SW is best-effort */
      });
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

  // Kick Render awake immediately (the socket handshake alone can time out
  // while the service is still spinning up).
  fetch('/wake', { cache: 'no-store' }).catch(() => {});

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
})();