# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local development (requires .env file)
npm install
npm run dev        # nodemon auto-reload

# Production
npm start          # node src/server.js

# Docker
docker compose up --build -d
docker compose logs -f
docker compose down

# Generate a session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

No test suite exists. There is no linter configured.

## Admin Guide wiki

`wiki/` holds the operator-facing Admin Guide as GitHub-Wiki pages (`Home.md`, `_Sidebar.md`, one page per topic; `wiki/README.md` explains publishing them to the Wiki tab). When you change behaviour they describe — admin controls, webhook events/payloads, scheduling rules, env vars, files in `DATA_PATH` — update the matching page in the same change (the table in `wiki/README.md` maps changes to pages).

## Environment Setup

Copy `.env.example` to `.env`. Key variables:

- `PLEX_URL` — must be a **local/LAN address** (e.g. `http://host.docker.internal:32400`), never the external domain. Plex transcoding requests must stay on the LAN.
- `COOKIE_SECURE` — set `true` only when behind HTTPS (reverse proxy). Controls the session cookie `secure` flag directly; **not** driven by `NODE_ENV`.
- `APP_URL` — public-facing URL, used to build the Plex OAuth callback URL.
- `PLEX_TOKEN` — server token from Plex Settings → Troubleshooting.
- `HDHR_IP` / `HDHR_PORT` — HDHomeRun tuner address. When set, Live TV video comes directly from the tuner via ffmpeg (Plex is then only used for the guide). `LIVETV_SOURCE=plex` forces the older Plex-DVR tuning path. `LIVETV_BUFFER_SEC` (default 10) is how far behind the newest recorded segment a room plays — the player can only buffer what the DVR holds, so this *is* the buffer. `LIVETV_HWACCEL=vaapi` encodes on an Intel or AMD iGPU via VAAPI (Linux only; the render node is auto-picked from `/dev/dri` by PCI vendor, override with `LIVETV_VAAPI_DEVICE`; `docker-compose.vaapi.yml` passes in `/dev/dri`; deinterlace stays on CPU; auto-falls back to x264 if the device is missing or ffmpeg fails twice with no output). `LIVETV_UPSCALE=720|1080` adds a Lanczos upscale (only for sources shorter than that) plus `LIVETV_SHARPEN` unsharp after the deinterlace (`videoFilter()` in live-relay.js). Optional encode tuning: `LIVETV_X264_PRESET`, `LIVETV_MAX_BITRATE`, `LIVETV_VIDEO_ARGS` (replaces the video encoder args, e.g. for NVENC; checked by `parseVideoArgs()` in `ffmpeg-args.js` — allow-listed encoder options, one simple value each, so it can't add outputs/inputs/filters; a failing value is ignored with a warning and the default encoder is used).

Sessions are stored in `session-file-store` at `/data/sessions` (Docker volume). The `DATA_PATH` env var overrides the base path for local dev.

## Architecture

### Real-time sync model

`src/sync.js` is the core. The server maintains authoritative playback state per room:

```
{ playing, position, lastUpdate }
```

Current position is computed as `position + (Date.now() - lastUpdate) / 1000` when playing. Clients receive a `state` event and **anchor the room clock to when it arrived** (`movieState`/`movieStateAt`, `movieTarget()`; `liveState`/`liveTarget()` for Live TV) — never `Date.now() - state.lastUpdate`, which mixes the client's and server's wall clocks and turns any skew into sync error (a 4 s skew made the old code run away from the room by >1 s in 30 s; the new code held 0.0 s). Movie/TV rooms then run a 250 ms chase loop in `player.js` (every viewer, host included, since anyone may scrub): proportional playback-rate correction (±8 %, 1 % steps, hysteresis 0.15/0.05 s, ≥1 s between changes), a hard seek only beyond `MOVIE_SEEK_SEC` (5 s) and at most once per `MOVIE_SEEK_GAP_MS` (8 s) so a stalled viewer can't chase the room in seek→rebuffer circles; a deliberate jump of the room clock (>1.5 s: someone scrubbed, a resync) lifts the gap so it's followed at once. A paused viewer is parked at the room position if it differs by >0.5 s. Guests also nudge `video.playbackRate` to stay in sync, and only the guest loop ever puts it back to 1 — so anything that stops that loop (becoming host, a paused room, a (re)join) must call `resetPlaybackRate()` in `player.js`, or the room plays at e.g. 0.93x forever (slowed, pitch-shifted audio until a refresh). The `isSyncing` flag in `player.js` prevents feedback loops when the player fires `play/pause/seeked` in response to programmatic changes.

### Live TV (DVR model)

`src/live-relay.js` owns Live TV media. Each livetv room has a `LiveDvr`: segments on disk under `DATA_PATH/dvr/<roomId>-<rand>/` (`s<N>.ts`), capped at 1 hour, served as a sliding HLS playlist at `/api/stream/live/:roomId/index.m3u8` (segments via `/live/:roomId/:segment`). Every segment carries `EXT-X-PROGRAM-DATE-TIME` derived from a fixed synthetic epoch, so a client converts its own `video.currentTime` ⇄ **DVR seconds** (`liveAbs()` / `liveSeekAbs()` in `player.js`). Room `position` for livetv rooms is in DVR seconds.

Two sources feed a DVR:
- **`HdhrSource`** (default when `HDHR_IP` is set): ffmpeg reads `http://HDHR_IP:HDHR_PORT/auto/v<channel>` (MPEG-2/AC3), deinterlaces, encodes H.264/AAC and writes 2s segments directly into the DVR dir (`-f segment`, csv segment list on stdout → `dvr.adopt()`). A watchdog restarts ffmpeg if no segment arrives for 15s; restarts are recorded as `EXT-X-DISCONTINUITY`. Nothing expires, so there is no retune cycle.
- **`LiveRelay`** (fallback, `LIVETV_SOURCE=plex`): polls Plex's transcode variant playlist and downloads segments. Plex live sessions die unpredictably, so `doRetune` (sync.js) stops the old subscription *then* tunes (Plex dedupes a second tune to the same dead item otherwise) and warm-swaps a new relay into the same DVR with a discontinuity. Rooms start 8s behind live to hide that gap.

A channel change always creates a fresh DVR (`startHdhr` / `startRelay({ fresh: true })`); the old one is destroyed after the new one is producing. Playback is **host-controlled**: only the host's play/pause/seek events are emitted; the server calibrates `room.position` from the host's reported DVR time every second, and guests steer onto it with a 250 ms proportional playback-rate loop (the `setInterval` drift loop in `player.js`; snap-seek only beyond 1.5 s). Guest targets use time since *receipt* of a state, not `state.lastUpdate`, so client/server clock skew doesn't leak into sync. Client Live TV debug lines are posted to `POST /api/stream/live-log` and appear in `docker compose logs` as `[LiveClient …]`.

### Watch nights, webhooks and voting

- **Recurring nights** (`scheduler.js`): a scheduled record may have `recurrence: 'weekly' | 'biweekly'`. On firing, the room is opened from a *snapshot* and the record is advanced in place via `addLocalDays` (`timeutil.js` — adds days in the event's timezone so local wall-clock time survives DST); the invite token is reused every night, the pre-picked movie is cleared, and occurrences overdue by >6h are skipped. `ical.js` builds the `.ics` (served publicly at `/join/:token/event.ics`; recurring ones use `DTSTART;TZID` + `RRULE`) and the Google Calendar link; `routes/schedule.js` attaches both to every record as `calendar`.
- **Webhooks** (`notifier.js`): configured at `/admin` (`routes/admin.js`, `requireAdmin` in server.js), stored in `DATA_PATH/webhooks.json`; the URL never leaves the server (`publicView` returns a hint). Events: `schedule.created`, `schedule.reminder`, `schedule.started`, `room.created`. A 30s ticker sends reminders once per night per webhook (`scheduler.markReminded` persists the mark). Discord and generic-JSON payloads are built in `bodyFor`. Delivery is best-effort and never throws.
- **Movie vote** (`voting.js` + handlers in `sync.js`): host-only `vote-start` draws a random deck from a 60s-cached library listing with `cleanFilters`/`matches`; votes live on `room.vote` keyed by *user id* (so reconnects keep swipes); `maybeFinalizeVote` reveals when every viewer id has swiped the whole deck (it re-runs on leave/kick/join). Cards sent to browsers never include `partId` or other people's votes; `vote-play` applies the pick through `applyMovie`. UI is `public/js/vote.js` (loaded after `player.js`, reuses its globals).

### People registry and nicknames

`users.js` persists every Plex account seen (`DATA_PATH/users.json`: id, Plex name, avatar, `nickname`, firstSeen, lastSeen, logins — no email). **The registry, not the session, owns nicknames**: `server.js` overwrites `displayName` from it on every Socket.io connection and `/api/me` (`users.touch(user).nickname`), the auth callback seeds the new session from it, and `POST /api/me/display-name` writes to it. That is what lets a nickname survive sign-outs and lets the admin *Reset nickname* (`DELETE /api/admin/users/:id/nickname`) take effect on the person's next load. A record adopts a session's existing `displayName` only on first sight, so a reset isn't undone by an old session. Nickname changes and new people are written immediately; `lastSeen` updates are batched (5s) and flushed on SIGTERM. `sync.onlineUserIds()` powers the admin list's online dot.

### Admin Settings (env vars in the UI)

`settings.js` is the registry (`DEFS`: opaque `id`, the underlying `env` name kept **server-side only**, friendly `label`/`description`, type/validation, default, `restart`) plus the layering: at load it records which variables were already defined in the environment (i.e. `.env`, via dotenv) as *locked*, then applies saved overrides from `DATA_PATH/settings.json` into `process.env` for the rest — so `.env` always wins, and the rest of the app keeps reading `process.env` unchanged. **It must be required before any module reads `process.env`** (server.js does so right after dotenv). `set()`/`reset()` (admin API `PUT|DELETE /api/admin/settings/:id`, page at `/admin/settings`) validate, persist, update `process.env` and fire `onChange(ids, fn)` hooks; an empty value means "back to default"; an empty value in `.env` counts as not defined. Anything a module cached at load must register a hook or be read at use time: `sync.js` (buffer, max Live TV rooms), `server.js` (room types — mutated in place; the Live TV router is always mounted behind an enabled check), `live-relay.js` (`hdhrIp()`/`hdhrPort()` read on use; the VAAPI device cache is reset). Only the Live TV guide server address is `restart: true` (`livetv-manager.js`/`stream.js` read it into constants). Secrets are `type: 'secret'` and only ever reported as configured/not set; URL settings strip embedded credentials. Saved overrides are re-validated through `normalize()` at load, and one that fails is skipped with a warning. When you add a setting: add a `DEFS` entry with friendly text, make sure the code reads it at use time (or add a hook), and add it to the wiki mapping table.

### Force resync

Host-only `force-resync` (sync.js): refuses if nothing is loaded (`resync-denied: nothing-playing`), if a countdown/intermission/resync is already running (`busy`), or within `RESYNC_COOLDOWN_MS` (10 s) of the last one (`cooldown` + `waitSec`). Otherwise it parks the room — `room.position` = the host's position (Live TV: the host's latest `position-report` extrapolated, else the room clock), `playing = false` — broadcasts state, then `resync { seconds: 2, position, by }` and a system chat line, and a `room.resyncTimer` sets `playing = true` after `RESYNC_SECONDS`. While `room.resyncTimer` is set, `play`/`pause`/`seek` are ignored so nothing resumes the room early; the timer is cleared on close/reset. Every client seeks to `position` on `resync` (needed for Live TV guests, whose drift loop only converges while playing) and shows `#resync-overlay`, timed locally from `seconds` (not `endsAt`) so clock skew can't matter. Separate from the film-leader `countdown` (host-set 3–99 s with beeps), which it deliberately doesn't reuse.

### Live TV pause cooldown

Rapid play/pause breaks a Live TV stream, so `sync.js` refuses a `pause` in a livetv room if the last accepted one was within `LIVETV_PAUSE_COOLDOWN_SEC` (default 10, 0 = off; read on use via `pauseCooldownMs()` so the admin Settings page applies it live). The check only applies while `room.playing` (a duplicate pause is never "too soon"), `room.lastPauseAt` is cleared on a fresh tune and on an always-on reset, and the refused client gets `pause-denied { waitSec }`. `state()` carries `pauseCooldownSec` so the host's page (`player.js`, the `pause` listener) undoes a too-soon pause immediately and shows a toast instead of waiting for the server; the server's word wins if the clocks disagree. Movie/TV/YouTube rooms are unaffected.

### Live TV capacity

`LIVETV_MAX_ROOMS` (whole number ≥ 1, default 2; bad values warn and fall back to 2) caps Live TV rooms that are *streaming*. `liveTvInUse(except)` in sync.js counts livetv rooms that are mid-tune or have a relay/DVR — idle rooms (empty always-on, no channel yet) are free, and `except` keeps a channel change inside an already-streaming room from counting as a second slot. The real gate is in `tuneRoomChannel` (check and `_tuningInProgress = true` in the same tick, so two rooms can't both squeeze in; failure is broadcast as `livetv-tune-failed` and returned as an error string); `create-room` also refuses a new Live TV room when full as a courtesy. `GET /api/livetv/capacity` returns `{ max, inUse }` for the lobby, whose "on now" strip shows the count, disables its cards when full, and refreshes shortly after each `room-list`.

### Always-on rooms

Owner-only rooms that never close. `always-on.js` persists the definitions (`DATA_PATH/always-on.json`: id, name, type, optional pinned Live TV channel, stable invite token); `restorePersistentRooms()` (server.js, after `setupSync`) recreates them at startup and `createPersistentRoom()` makes the live `Room` (`persistentId`, `awaitingHost = true`, `pendingChannel`). When the last person leaves, the host-disconnect path (sync.js) starts a **10 s grace** and then `resetPersistentRoom()` returns the room to waiting (no host, settings/votes/bans cleared, Live TV recording stopped via `stopRelay`, pinned channel re-armed as `pendingChannel`); `closeRoom()` on a persistent room ejects everyone and resets instead of deleting, and `removePersistentRoom()` (admin DELETE) really closes it. A newcomer inside the grace window triggers an immediate reset so they become host. The `join-room` waiting-for-host rule differs by room kind: **scheduled** rooms only let a Plex user take the empty host seat, **always-on** rooms also let a guest holding the invite token take it (`guestMayOpen`; `hostIsGuest = true`, `hostId = null`, same as host migration). **Live TV tunes on first join** through the same `pendingChannel` → `tuneRoomChannel()` path the lobby "on now" cards use. `tuneRoomChannel` guards against stale tunes (`room._tuneGen` bumped on reset; `rooms.get(id) !== room`), and `live-relay.js` registers in-flight tunes in `pendingTunes` so `stopRelay` can cancel one still waiting for its first video — otherwise a room closed mid-tune left ffmpeg holding a tuner. `join-room` now also calls `broadcastRoomList` so lobby viewer counts update on arrival.

### Lobby "Live TV: on now"

`lobby.js` `loadLiveNow()` reads the existing `/api/livetv/guide` (cached in `livetv-manager.js`), keeps channels with a `nowPlaying`, sorts `x.1` main networks first and caps at 14 plus a "More channels" card; it only shows when `/api/config` says `livetv` is enabled. Both lobby strips share one prompt (`#recent-modal`). A card emits `create-room` with `preload: { kind: 'livetv', channel }`; `preloadLiveTv()` in sync.js looks the channel up **in the guide server-side** (unknown/odd values are rejected) and stores `room.pendingChannel`. The tune itself waits until the host's watch page joins (`join-room` → `tuneRoomChannel()`), because the tuning overlay needs a viewer connected. `tuneRoomChannel()` is the single implementation of tuning, shared with the host's channel picker (`select-livetv-channel`).

### Lobby "recently added"

`routes/recent.js` (`GET /api/recent`, 2-minute cache) merges the newest movies across all movie libraries (deduped by title+year, so HD and 4K copies don't both show) and groups Plex's recently-added *episodes* into one card per show, keyed to the first episode of that show's latest drop (episodes added within 3 days of its newest). A card click emits `create-room` with `preload: { kind, ratingKey }` (`kind 'tv'` takes an *episode* key); `preloadRoom()` in sync.js resolves title, part and episode list server-side — the browser never supplies a partId — and the room is named after the title. The host's `select-movie` (`movieKey`) and `select-show` (`episodeRatingKey`) go through the same `preloadRoom()`, and `POST /api/schedule` looks its `movieKey` up in Plex too; any title/partId the browser sends is ignored.

### Multi-room system

- `rooms` Map (roomId → Room) and `inviteTokens` Map (token → roomId) live in memory in `sync.js` — rooms are **not** persisted.
- `socketToRoom` Map enables O(1) lookup when any socket event arrives.
- Host disconnect triggers a **30-second grace timer** before closing the room, to survive lobby→watch page navigation (which creates a new socket). The timer is cancelled if the host rejoins before it fires.
- Guests are validated by comparing `user.inviteToken` (stored in session) against `room.inviteToken`.

### Plex HLS proxy

Plex's `/video/:/transcode/universal/start.m3u8` returns an HLS manifest containing internal Plex URLs and tokens. The proxy pipeline:

1. `GET /api/stream/hls/:ratingKey/master.m3u8` — starts a Plex transcode session and rewrites all URLs in the returned m3u8 to `/api/stream/proxy/…`, stripping `X-Plex-Token`.
2. `GET /api/stream/proxy/*` — forwards requests to Plex (adding the token server-side). m3u8 files are buffered and rewritten; `.ts` segments are piped directly.
3. The `baseDir` variable is critical for resolving **relative** paths in sub-manifests (Plex returns paths like `session/xxx/base/index.m3u8` with no leading slash).

**Proxy path check**: `resolveProxyUrl()` resolves the target with WHATWG `URL`, the same way axios does (which collapses `..`, `%2e`, etc.), and runs the allow-list on *that* pathname. Never test the raw `req.params[0]`: Express decodes `%2F`, so `…/universal/..%2F..%2F..%2F..%2Fmyplex/account` would reach any Plex endpoint with the server token.

**Important quirk**: axios encodes `/` as `%2F` in query params. The `path` param sent to Plex requires literal slashes, so the query string is built manually in `stream.js`.

### Auth flow

- Plex OAuth uses PIN-based flow (not standard OAuth redirect). The PIN ID is in the **callback URL path** (`/auth/plex/callback/:pinId`) *and* stored in the session (`plexPinId`) when `/auth/plex` starts. The callback refuses a PIN that this browser didn't start, because PIN IDs are guessable and anyone could otherwise claim someone else's approved sign-in. The `SameSite=Lax` cookie survives Plex's top-level redirect back. Since that redirect lands on `APP_URL`, `/auth/plex` started on any other host first bounces once to `APP_URL/auth/plex?h=1`.
- Guest join calls `session.regenerate`. A guest's stream access is scoped in `stream.js` (`guestRoom()`): `/hls` only for their invite's room and its current `movieKey` (no `?live`), `/live/:roomId` only for that room, and `/proxy*` only for transcode session ids seen in that room's manifests (`roomTranscodeSessions`). Plex users aren't scoped.
- After OAuth, the server verifies the user has access to the local Plex server by hitting `PLEX_URL` with their token.
- Guests get a session with `{ isGuest: true, name, inviteToken }` via `POST /auth/guest-join`.
- **Admin = Plex server owner.** The plex.tv `/resources` entry matching the server's `machineIdentifier` has `owned: true` only for the owner; login stores that as `session.user.isAdmin`. Admins get: `admin-close-room` / `admin-kick` socket events (sync.js; kicks also block rejoining that room), kick buttons in any room they join, a per-room viewer/close panel in the lobby (admin sockets join the `admins` socket.io room and receive a detailed `room-list`), and may cancel any scheduled room (`DELETE /api/schedule/:id`). Admins can't be kicked and the host can only be removed by closing the room. Existing sessions pick this up on next sign-in.
- `requireAuth` — any session user (Plex or guest). `requirePlexAuth` — non-guest only.

### Socket authentication

In `io.on('connection')`, sync.js wraps `socket.on`. Every handler gets `{}` in place of a null, missing or non-object payload, and anything a handler throws or rejects with is logged as `[Socket] "event" … failed`. Socket.io dispatches handlers on `process.nextTick`, so without this, one `emit('play', null)` from any guest is an uncaught exception that kills the server and every in-memory room. Keep socket payloads as objects. `validPosition()` rejects non-numeric play/pause/seek positions.


Session middleware is shared between Express and Socket.io (both use the same `sessionMiddleware` instance). A Socket.io middleware layer reads `socket.request.session.user` and attaches it as `socket.user`.

### Frontend pages

- `index.html` + `lobby.js` — room list, create room modal (Plex users only)
- `watch.html` + `player.js` — video player, sidebar (viewers, invite link, sync status), movie browser modal (host only)
- `join.html` — public invite landing page; fetches `/join/:inviteToken/info` for roomId, then POSTs guest session
- `login.html` — Plex-only login page

The watch page uses the browser's native `<video controls>`, so its control bar/timeline can't be restyled; the overlays on the player (reaction bar, Guide button and panel, Go live) sit along the **top** of the video, away from it, positioned by the `--ovl-top` / `--guide-top` variables on `.player-container` (end of `app.css`) — change those, not per-element offsets. The host-only **Go live** button exists twice (sidebar `#livetv-golive` and player `#livetv-golive-player`); both share one rule and handler in `player.js`.

Browser-side `esc()` / `escapeHtml()` helpers (player, lobby, browser, vote, admin, admin-settings) escape `& < > " '`, so they're safe inside attribute values as well as text; keep it that way when adding one. User text (chat, names, room titles) is stored and sent **unescaped** — server-side `sanitizeText()` (`sanitize.js`) only strips control characters — so every render must escape it (or use `textContent`); encoding on the server too made `&quot;`/`&#39;` show literally.

All styling is in a single `src/public/css/app.css`. The theme is the "Homelab Console" look (dark, hairline borders, one amber accent, monospace for technical text) defined as `--pd-*` tokens at the top of the file; the older variable names (`--bg`, `--accent`, …) are aliases onto those tokens. Movie/show pickers share a grid/list toggle (`js/viewtoggle.js`, preference kept in `localStorage`).
