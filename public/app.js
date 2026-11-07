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
    settings: { roundMinutes: 15, pingInterval: 30 },
    myCode: null,
    isTagged: false,
    myPos: null,

    map: null,
    mapReady: false,
    selfMarker: null,
    accuracyCircle: null,
    pingMarkers: new Map(), // id -> { marker, lat, lng, ts, nickname, role }
    centeredOnce: false,
    userPanned: false,

    timerSync: null,
    watchId: null,
    gpsRetryTimer: null,
    lastLocationSentAt: 0,
    gpsOk: false,

    pingRafPending: false,
    pendingPings: null,
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
    btnCreate: $('btn-create'),

    btnShowJoin: $('btn-show-join'),
    joinPanel: $('join-panel'),
    roomInput: $('room-input'),
    btnJoin: $('btn-join'),
    iosHint: $('ios-install-hint'),

    roomCode: $('room-code'),
    btnLeave: $('btn-leave'),
    myCode: $('my-code'),
    myStatus: $('my-status'),
    hostControls: $('host-controls'),
    hostRoundRange: $('host-round-range'),
    hostRoundVal: $('host-round-val'),
    hostNoLimit: $('host-no-limit'),
    hostPingRange: $('host-ping-range'),
    hostPingVal: $('host-ping-val'),
    btnStart: $('btn-start'),
    playerList: $('player-list'),
    playerCount: $('player-count'),

    map: $('map'),
    timer: $('timer'),
    roleBadge: $('role-badge'),
    hudCode: $('hud-code'),
    btnPlayers: $('btn-players'),
    btnTag: $('btn-tag'),
    btnRecenter: $('btn-recenter'),
    gpsBanner: $('gps-banner'),
    hiddenBanner: $('hidden-banner'),

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
      // Leaflet needs a tick after the container becomes visible.
      requestAnimationFrame(() => {
        if (S.map) S.map.invalidateSize();
      });
      if (!window.__timerLoop) {
        window.__timerLoop = true;
        requestAnimationFrame(timerLoop);
      }
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
    setScreen('home');
  });

  /* ================================================================ */
  /* Game lifecycle                                                   */
  /* ================================================================ */

  socket.on('game_started', (data) => {
    S.myCode = data.code;
    S.isTagged = data.isTagged;
    S.timerSync = data.endsAt
      ? { msLeft: Math.max(0, data.endsAt - data.serverTime), at: performance.now() }
      : { msLeft: null, at: performance.now() };

    clearPingMarkers();
    setScreen('game');
    renderGameHud();
    startGps();
    toast(data.isTagged ? 'You are PATIENT ZERO. Hunt the survivors!' : 'You are a SURVIVOR. Run!', data.isTagged ? 'zombie' : null);
  });

  socket.on('time_remaining', (data) => {
    S.timerSync = { msLeft: data.msLeft, at: performance.now() };
  });

  socket.on('ping_batch', (data) => {
    S.pendingPings = data.pings || [];
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
      toast('You have been tagged — you are now a ZOMBIE.', 'zombie');
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

    el.overTitle.textContent = data.winner === 'zombies' ? 'ZOMBIES WIN' : 'SURVIVORS WIN';
    el.overSub.textContent =
      data.winner === 'zombies'
        ? 'Every player was infected.'
        : 'The round timer expired — the survivors made it.';

    el.overList.innerHTML = '';
    (data.players || [])
      .slice()
      .sort((a, b) => Number(b.isTagged) - Number(a.isTagged))
      .forEach((p) => {
        const li = document.createElement('li');
        li.innerHTML =
          `<span class="who"><span class="name">${escapeHtml(p.nickname)}</span></span>` +
          `<span class="state ${p.isTagged ? 'zombie' : 'alive'}">${p.isTagged ? 'Zombie' : 'Survived'}</span>`;
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

    el.myStatus.textContent = S.isTagged ? 'Zombie' : 'Survivor';
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
        ? '<span class="state zombie">Zombie</span>'
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

    el.roleBadge.textContent = S.isTagged ? 'ZOMBIE' : 'SURVIVOR';
    el.roleBadge.classList.toggle('zombie', !!S.isTagged);

    el.hudCode.textContent = S.myCode;
    el.hudCode.classList.toggle('greyed', !!S.isTagged);

    el.btnTag.hidden = !S.isTagged;
  }

  function timerLoop() {
    if (S.screen !== 'game') {
      window.__timerLoop = false;
      return;
    }
    if (S.timerSync) {
      if (S.timerSync.msLeft === null) {
        el.timer.textContent = 'NO LIMIT';
      } else {
        const left = Math.max(0, S.timerSync.msLeft - (performance.now() - S.timerSync.at));
        el.timer.textContent = formatClock(left);
      }
    } else {
      el.timer.textContent = '--:--';
    }
    requestAnimationFrame(timerLoop);
  }

  /* ================================================================ */
  /* Map                                                              */
  /* ================================================================ */

  function ensureMap() {
    if (S.mapReady) return;
    S.mapReady = true;

    S.map = L.map(el.map, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    }).setView([20, 0], 2);

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution:
          'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maxZoom: 19,
      }
    ).addTo(S.map);

    S.map.on('dragstart', () => {
      S.userPanned = true;
    });
  }

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
      S.map.setView([lat, lng], 18);
    }
  }

  function popupHtml(ping) {
    const dist = S.myPos
      ? haversine(S.myPos.lat, S.myPos.lng, ping.lat, ping.lng)
      : null;
    return (
      '<div class="popup">' +
      `<strong>${escapeHtml(ping.nickname)}</strong>` +
      `<div class="popup-dist">${dist === null ? 'Distance unknown' : formatDistance(dist)}</div>` +
      `<div class="popup-meta">${ping.role === 'zombie' ? 'Zombie' : 'Survivor'} · pinged ${timeAgo(ping.ts)}</div>` +
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

    for (const ping of pings) {
      seen.add(ping.id);
      const existing = S.pingMarkers.get(ping.id);

      if (
        existing &&
        existing.ts === ping.ts &&
        existing.lat === ping.lat &&
        existing.lng === ping.lng
      ) {
        continue; // unchanged fix — do not restart the pulse
      }

      if (existing) S.map.removeLayer(existing.marker);

      const icon = L.divIcon({
        className: 'ping-icon-wrap',
        html:
          `<div class="ping-marker ${ping.role}">` +
          '<span class="pulse"></span><span class="dot"></span>' +
          '</div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -12],
      });

      const marker = L.marker([ping.lat, ping.lng], { icon, keyboard: false }).addTo(S.map);
      marker.bindPopup(() => popupHtml(ping));

      S.pingMarkers.set(ping.id, {
        marker,
        lat: ping.lat,
        lng: ping.lng,
        ts: ping.ts,
        nickname: ping.nickname,
        role: ping.role,
      });
    }

    // Players that are no longer visible (tagged, disconnected, out of range)
    for (const [id, entry] of S.pingMarkers) {
      if (!seen.has(id)) {
        S.map.removeLayer(entry.marker);
        S.pingMarkers.delete(id);
      }
    }
  }

  function clearPingMarkers() {
    if (S.map) {
      for (const entry of S.pingMarkers.values()) S.map.removeLayer(entry.marker);
    }
    S.pingMarkers.clear();
  }

  el.btnRecenter.addEventListener('click', () => {
    if (S.map && S.myPos) {
      S.userPanned = false;
      S.map.setView([S.myPos.lat, S.myPos.lng], Math.max(S.map.getZoom(), 17));
    }
  });

  /* ================================================================ */
  /* GPS                                                              */
  /* ================================================================ */

  function startGps() {
    if (S.watchId !== null) return;
    if (!('geolocation' in navigator)) {
      showGpsBanner('This device/browser does not support geolocation.');
      return;
    }

    S.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, GEO_OPTS);
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

    const now = performance.now();
    if (now - S.lastLocationSentAt >= LOCATION_SEND_MS) {
      S.lastLocationSentAt = now;
      socket.emit('location_update', { lat, lng, accuracy });
    }
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

  /* --- Foreground-only warning (iOS PWA cannot do background GPS) --- */
  document.addEventListener('visibilitychange', () => {
    if (S.screen !== 'game') return;
    el.hiddenBanner.hidden = document.visibilityState !== 'hidden';
    if (document.visibilityState === 'visible' && S.gpsOk) hideGpsBanner();
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
      el.noLimit.checked = !!savedSettings.noLimit;
    }
  } catch (_) {
    /* ignore */
  }

  function syncHomeSettingsLabels() {
    const noLimit = el.noLimit.checked;
    el.roundRange.disabled = noLimit;
    el.roundVal.textContent = noLimit ? 'No limit' : el.roundRange.value + ' min';
    el.pingVal.textContent = el.pingRange.value + ' s';
  }
  syncHomeSettingsLabels();

  el.roundRange.addEventListener('input', syncHomeSettingsLabels);
  el.noLimit.addEventListener('change', syncHomeSettingsLabels);
  el.pingRange.addEventListener('input', syncHomeSettingsLabels);

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
      noLimit: el.noLimit.checked,
    };
    localStorage.setItem(
      LS_SETTINGS,
      JSON.stringify({
        roundMinutes: payload.roundMinutes,
        pingInterval: payload.pingInterval,
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
        ? '<span class="state zombie">Zombie</span>'
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
})();