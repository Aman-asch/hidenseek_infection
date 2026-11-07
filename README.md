\# Infection — Real-time Multiplayer GPS Infection Game (PWA)



A no-accounts, room-code-based GPS tag game. One player is \*\*Patient Zero\*\*; everyone

else is a \*\*Survivor\*\*. Zombies physically find survivors and type the survivor's

\*\*3-digit code\*\* into their phone to infect them. Zombies see living survivors on the

satellite map via periodic \*\*pings\*\*; survivors see zombies the same way. Nobody ever

sees live, continuous positions of the enemy team.



\- \*\*Backend:\*\* Node.js + Socket.IO, in-memory state only, designed for Render's free tier.

\- \*\*Frontend:\*\* Vanilla JS + Leaflet with \*\*Esri World Imagery\*\* satellite tiles.

\- \*\*PWA:\*\* installable on Android (Chrome install prompt) and iOS (Share → Add to Home Screen).



\---



\## 1. Deploy to Render (free tier)



\### Option A — `render.yaml` (recommended)



1\. Push this repo to GitHub.

2\. In Render: \*\*New → Blueprint\*\*, pick the repo. Render reads `render.yaml`.

3\. Wait for the build (`npm install \&\& npm run build` — the build step generates the PNG icons).

4\. Open the URL. First load takes up to \~60 s while the free instance cold-starts.



\### Option B — manual Web Service



| Setting | Value |

|---|---|

| Environment | `Node` |

| Build command | `npm install \&\& npm run build` |

| Start command | `node server.js` |

| Health check path | `/health` |

| Instance type | `Free` |



`PORT` is injected by Render and the server picks it up automatically.



\### Local development



```bash

npm install

npm run build     # generates public/icons/\*.png

npm start         # http://localhost:3000

```



> \*\*HTTPS is required for geolocation.\*\* `localhost` is exempt. To test on a phone

> on your LAN you must use a tunnel with TLS (e.g. `ngrok http 3000`) or deploy to Render.



\---



\## 2. Render free tier: the 15-minute idle rule and the keep-alive



Render's free web services \*\*spin down after 15 minutes without inbound traffic\*\*.

An open, silent WebSocket connection does \*\*not\*\* count as traffic.



This app works around that:



1\. The server runs `setInterval(..., 4 \* 60 \* 1000)` and emits a lightweight

&#x20;  `heartbeat` event to \*\*every\*\* connected socket.

2\. On receipt, the client immediately replies with `heartbeat\_ack`.

3\. That reply is \*\*inbound traffic to the server\*\*, which resets Render's idle timer.



Because the heartbeat fires every 4 minutes — well inside the 15-minute window —

a server with at least one connected client stays warm indefinitely.



\*\*Limitations you should know:\*\*



\- With \*\*zero\*\* clients connected for 15 minutes, the service sleeps. The next player

&#x20; triggers a \~60 s cold start.

\- While spinning up, Render serves its own loading page. Socket.IO's handshake will

&#x20; fail during that window; the client retries automatically.

\- The client never silently hangs: a full-screen \*\*"Connecting to server… this may take

&#x20; up to a minute on first launch"\*\* overlay with a spinner and a \*\*Retry now\*\* button is

&#x20; shown until the socket connects.

\- On boot the client also fires a `GET /wake` request immediately, so Render starts

&#x20; warming up while the overlay is displayed.



\---



\## 3. iOS PWA caveats (explicit assumptions)



\- \*\*Background location is not supported\*\* in iOS home-screen PWAs. The game is designed

&#x20; to be played with the app \*\*open and the screen on\*\*. No background geolocation API or

&#x20; workaround is attempted. If the document becomes hidden during a round, a red banner

&#x20; appears telling the player to return to the app.

\- \*\*Geolocation permission from a home-screen launch can fail on iOS.\*\* If it does, the

&#x20; app shows:

&#x20; > \*If location is not working, please open this site in Safari instead of the home

&#x20; > screen app, and allow location access.\*

\- Install on iOS: \*\*Safari → Share → Add to Home Screen\*\*. The app shows this hint

&#x20; automatically when it detects iOS in a non-standalone context.

\- Install on Android: Chrome shows the native install prompt (`beforeinstallprompt`);

&#x20; the home screen shows a tappable "Add to Home Screen" hint.



\---



\## 4. How the 3-digit tagging flow works



1\. When a player joins a room, the server pops a code from a \*\*shuffled pool of

&#x20;  `000`–`999`\*\* and assigns it. Codes are unique per room and \*\*never reused\*\* for

&#x20;  that round.

2\. A player's code is only ever transmitted \*\*to that player's own socket\*\* — it never

&#x20;  appears in any broadcast, so no other player can see it.

3\. When the host starts, one random player becomes \*\*Patient Zero\*\* (`isTagged = true`).

4\. A zombie physically approaches a survivor, opens \*\*Tag Player\*\*, and types the

&#x20;  3-digit code shown on the survivor's phone.

5\. The server validates:

&#x20;  - the round is running,

&#x20;  - the submitter is a zombie,

&#x20;  - the code matches a \*\*living survivor\*\* in that room.

6\. On success the survivor flips to `isTagged = true` and immediately becomes a zombie

&#x20;  (they can now tag others). Their code is no longer needed and is greyed out.

7\. The round ends when \*\*every\*\* player is tagged (\*\*zombies win\*\*) or the server-owned

&#x20;  round timer hits zero (\*\*survivors win\*\*). The server broadcasts `game\_over` and all

&#x20;  room state is discarded.



\---



\## 5. GPS accuracy



\- Client uses `navigator.geolocation.watchPosition` with

&#x20; `{ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }`.

\- Every fix is forwarded to the server — \*\*raw, unrounded, unoffset\*\*.

\- Location updates are throttled client-side to \*\*max 1 per second\*\*.

\- The server stores only the latest known coordinates per player and never modifies them.

\- Pings are sent as a \*\*single `ping\_batch` event\*\* per player per interval (not one event

&#x20; per player) and use Socket.IO's \*\*volatile\*\* flag, so stale pings are dropped rather

&#x20; than queued for a briefly disconnected client.

\- Markers are \*\*removed and recreated\*\* at the new coordinates (with a drop/pulse

&#x20; animation) — never tweened — so the map never implies continuous tracking.



\### Visibility rules



| You are | You can see |

|---|---|

| Survivor | all \*\*zombies\*\* (periodic pings) + yourself |

| Zombie | all \*\*living survivors\*\* (periodic pings) + yourself |



Distances in marker popups are computed client-side with the \*\*Haversine formula\*\*

against your own latest fix: metres under 1 km, otherwise kilometres to one decimal.



\---



\## 6. Server event reference



\*\*Client → Server\*\*



| Event | Payload | Notes |

|---|---|---|

| `create\_room` | `{ sessionId, nickname, roundMinutes, pingInterval, noLimit }` | ack `{ ok, roomCode }` |

| `join\_room` | `{ sessionId, roomCode, nickname }` | ack `{ ok, roomCode, phase }` |

| `reconnect\_room` | `{ sessionId, roomCode }` | restores within the 2-min grace |

| `update\_settings` | `{ roundMinutes, pingInterval, noLimit }` | host only, lobby only |

| `start\_game` | `{}` | host only, ≥ 2 players |

| `location\_update` | `{ lat, lng, accuracy }` | ≤ 1/s |

| `submit\_tag` | `{ code }` | ack `{ ok, tagged }` |

| `leave\_room` | `{}` | |

| `heartbeat\_ack` | `{ t }` | keep-alive reply |



\*\*Server → Client\*\*



| Event | Payload |

|---|---|

| `room\_state` | full per-socket state (includes \*\*only your own\*\* 3-digit code) |

| `game\_started` | `{ code, isTagged, endsAt, roundMinutes, pingInterval, serverTime }` |

| `time\_remaining` | `{ msLeft, serverTime }` (every 5 s) |

| `ping\_batch` | `{ pings: \[{ id, nickname, lat, lng, accuracy, ts, role }], serverTime }` (volatile) |

| `player\_tagged` | `{ sessionId, nickname, byNickname, youAreZombie }` |

| `game\_over` | `{ winner, reason, players }` |

| `room\_left` | `{ roomCode }` |

| `heartbeat` | `{ t }` |



\---



\## 7. Edge cases handled



\- \*\*Disconnects:\*\* the player's entry is kept for \*\*2 minutes\*\*; reconnecting with the

&#x20; same `sessionId` + room code restores role, code and status. After that the player is

&#x20; removed and the win condition is re-evaluated.

\- \*\*Host disconnects:\*\* host is \*\*not\*\* transferred. The room keeps running; the host is

&#x20; only needed to start the round.

\- \*\*Invalid room code / already started:\*\* clear errors returned to the joiner.

\- \*\*Room capacity:\*\* capped at \*\*999\*\* (the 3-digit code space). Joins beyond that, or

&#x20; after the code pool is exhausted, are rejected with a clear message.

\- \*\*GPS unavailable:\*\* amber banner + automatic retry every 10 s.

\- \*\*Clock skew:\*\* the server owns the timer. The client stores the last

&#x20; `{ msLeft, receivedAt }` pair and interpolates using `performance.now()` (a monotonic

&#x20; clock), never wall-clock time.

\- \*\*Service worker\*\* never intercepts `/socket.io`, tiles, `/health` or `/wake`.

