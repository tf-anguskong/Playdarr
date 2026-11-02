# Playdarr

> ⚠️ **Vibe coded.** This entire application was built through conversational prompting with Claude (claude-sonnet-4-6) — no traditional development workflow. The code works, but it has not been audited, formally tested, or reviewed by anyone who would describe themselves as sober. Use accordingly.

Playdarr is a self-hosted watch-party app for Plex. It lets you and your friends stream movies from your Plex server in sync, with real-time chat, reactions, and playback controls — all through a browser, no plugins required.

## What is Playdarr?

Playdarr is a self-hosted watch-party app built around Plex. The idea is simple: you own the media, you own the server, and you invite whoever you want to watch with you — no subscriptions, no third-party accounts, no data leaving your infrastructure.

A Plex user creates a room, shares an invite link, and guests join straight from their browser. Playback is kept in sync across all viewers automatically. Everyone gets chat, reactions, and a shared experience without anyone needing a Plex account except the person hosting.

---

## Features

### Watching
- **Synchronised playback** — play, pause, and seek are broadcast to everyone in the room; clients drift-correct every 5 seconds using gradual playback rate nudging before falling back to a hard seek
- **Plex HLS proxy** — transcodes via your local Plex server and routes all HLS traffic through the app server, so your Plex token is never exposed to clients
- **Movie browser** — searchable, filterable (genre, rating, year) picker for your Plex library, host-only; switch between a poster grid and a compact list view (remembered per browser)
- **YouTube rooms** — create a YouTube room instead of a movie room; the host pastes any `youtube.com` or `youtu.be` URL and the video embeds for all viewers via the YouTube IFrame API, fully synchronised; the video title is fetched automatically and shown in the sidebar and room list
- **Live TV rooms** — watch live television together. The host picks a channel from an EPG guide (Plex supplies the channel list and now-playing programme info, also shown in the channel picker). Video comes **straight from your HDHomeRun** — ffmpeg (bundled in the Docker image) converts the broadcast MPEG-2/AC3 feed to H.264/AAC — and is recorded to a per-room **DVR on disk** (rolling 1 hour). The host controls playback: pause, rewind and seek within the DVR, or hit **Go live**; guests follow, with a "LIVE / -m:ss behind live" readout. A channel change starts a fresh DVR. If no HDHomeRun is configured, Live TV falls back to tuning through Plex's DVR
- **Multi-room** — multiple watch parties can run simultaneously, each with their own state

### Rooms & Access

> **Who can create rooms?** Only users authenticated against your own Plex server can create rooms or schedule sessions. Playdarr verifies at login that the authenticating Plex account actually has access to the configured `PLEX_URL` — if they don't, they can't log in. Guests (people without a Plex account) can only join via an invite link shared by a Plex user; they cannot create rooms, schedule sessions, or access the lobby independently. A guest can be granted host of an existing room via transfer or auto-migration, but that only gives them control over playback — they still cannot open new rooms.

- **Plex login** — sign in via Plex OAuth; only accounts with verified access to your Plex server can log in and create rooms
- **Guest invite links** — hosts share a link; guests enter a display name and join without a Plex account; guests cannot see the lobby or create rooms
- **Host transfer** — the host can promote any viewer (including guests) to host mid-session, giving them playback control for that room; guests granted host cannot create new rooms or scheduled events
- **Auto host migration** — if the host leaves and other viewers remain, the room automatically promotes the next best viewer (preferring Plex users over guests) rather than closing
- **Server-owner admin** — whoever *owns* the Plex server Playdarr is connected to is detected automatically at login (plex.tv marks the account as owner of that server), with no extra config. Admins get an `admin` badge and can close any room, kick any viewer (and block them from rejoining that room) from the lobby or from inside a room, and cancel any scheduled room. Other users, including hosts, can't kick an admin. Sign out and back in after upgrading for the owner flag to be picked up.
- **Room persistence** — rooms live in memory; a 30-second grace timer keeps a room alive if the host briefly navigates away

### Scheduled Rooms

> Scheduling is Plex-only. Guests cannot schedule rooms.

- **Schedule a room** — Plex users can schedule a watch party in advance, picking a date/time, timezone, room name, and optionally pre-selecting a movie
- **Pre-shared invite links** — the invite link is generated at scheduling time and can be shared immediately; it works both before and after the room opens
- **Waiting page** — guests who arrive early see a branded waiting page showing the scheduled date/time in their local timezone; the page polls in the background and redirects automatically when the room opens
- **First-joiner becomes host** — when the scheduled time arrives and the room opens, whoever joins first is granted host, regardless of whether they have a Plex account
- **Persistent schedule** — upcoming scheduled rooms survive server restarts (`DATA_PATH/scheduled.json`); the timer re-arms on startup
- **Default timezone** — set `DEFAULT_TIMEZONE` in `.env` to pre-fill the timezone picker when scheduling (e.g. `America/New_York`)

### Social
- **Real-time chat** — all viewers can send messages; chat includes the sender's current movie timestamp for context
- **Chat export** — download the full chat log as a `.txt` file with video timestamps
- **Play/pause attribution** — a system message appears in chat whenever someone plays or pauses, showing who did it and at what position
- **Emoji reactions** — a reaction bar (👍 ❤️ 😂 😱 😮 👏) overlays the video on hover; reactions float up the screen for all viewers, each tagged with the avatar (or initial) of whoever sent it
- **Sync indicators** — the viewer list shows each viewer's offset from the host (e.g. `+0.3s`), colour-coded green / amber / red
- **Countdown timer** — host can fire a countdown (3 s, 5 s, 10 s, or custom) before playback begins; all viewers see a film-leader overlay with beep tones; host can cancel mid-count
- **Intermission** — host can start a timed intermission (1–120 minutes); the video pauses for everyone and an overlay displays the movie poster with a live MM:SS countdown; the movie resumes automatically when the timer ends, or the host can end it early

---

## Stack

- **Backend** — Node.js, Express, Socket.io
- **Frontend** — vanilla JS, no framework
- **Streaming** — Plex HLS transcoding proxied server-side for movies/TV; Live TV via ffmpeg from an HDHomeRun into an on-disk HLS DVR; [HLS.js](https://github.com/video-dev/hls.js) on the client
- **Auth** — Plex PIN-based OAuth for Plex users; session-based guest tokens for invited viewers
- **Sessions** — `express-session` with `session-file-store`
- **Deployment** — Docker + reverse proxy of your choice

---

## Setup

### Prerequisites
- A running Plex Media Server accessible on your LAN
- Docker (recommended) or Node.js 18+
- For Live TV: a Plex DVR setup (e.g. HDHomeRun) with channels configured in Plex

### 1. Clone and configure

```bash
git clone https://github.com/tf-anguskong/Playdarr.git
cd Playdarr
cp .env.example .env
```

Open `.env` and fill in the required values — see the [Configuration](#configuration) section below for details. At minimum you need `SESSION_SECRET`, `PLEX_URL`, `PLEX_TOKEN`, `APP_URL`, and `COOKIE_SECURE`.

### 2. Run with Docker (recommended)

```bash
docker compose up --build -d
docker compose logs -f
```

Playdarr will be available at `http://localhost:3000` (or whichever `PORT` you configured).

### 3. Expose it to the internet

Playdarr needs to be reachable over HTTPS for guests to join from outside your network. Serve it however you like — NGINX, Caddy, Traefik, Tailscale, or any other reverse proxy or tunnel solution.

A minimal NGINX config:

```nginx
server {
    listen 443 ssl;
    server_name playdarr.yourdomain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;

        # Required for Socket.io
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Allow long-lived HLS segment requests
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Set `APP_URL` to your domain and `COOKIE_SECURE=true` in `.env`.

> **Tip:** [NGINX Proxy Manager](https://nginxproxymanager.com/) provides a web UI that handles proxy hosts, SSL certificates (via Let's Encrypt), and WebSocket support with minimal configuration. It runs as a Docker container and is a popular choice for home lab setups.

---

### Local development

```bash
cp .env.example .env
# Edit .env — set APP_URL=http://localhost:3000 and COOKIE_SECURE=false
npm install
npm run dev   # nodemon auto-reload on http://localhost:3000
```

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes | Random secret for signing session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PLEX_URL` | Yes | Local/LAN address of your Plex server as seen from the Docker container (e.g. `http://host.docker.internal:32400`). **Never use your external domain** — transcoding traffic must stay on your LAN. |
| `PLEX_TOKEN` | Yes | Server token from Plex Settings → Troubleshooting |
| `APP_URL` | Yes | Public-facing URL of this app, used to build the Plex OAuth callback (e.g. `https://playdarr.yourdomain.com` or `http://localhost:3000` for local dev) |
| `COOKIE_SECURE` | Yes | `true` when running behind HTTPS, `false` for local dev |
| `PLEX_CLIENT_ID` | No | Identifier sent to Plex — any stable string (default: `playdarr-app`) |
| `DEFAULT_TIMEZONE` | No | IANA timezone used as the default when scheduling rooms (e.g. `America/New_York`). Falls back to `UTC`. |
| `PORT` | No | Port to listen on (default: `3000`) |
| `ROOM_TYPE_MOVIE` | No | Set `false` to hide movie rooms from the lobby (default: `true`) |
| `ROOM_TYPE_TV` | No | Set `false` to hide TV show rooms from the lobby (default: `true`) |
| `ROOM_TYPE_YOUTUBE` | No | Set `false` to hide YouTube rooms from the lobby (default: `true`) |
| `ROOM_TYPE_LIVETV` | No | Set `true` to enable Live TV rooms (default: `false`) |
| `LIVETV_PLEX_HOST` | No | LAN address of the Plex server used for the Live TV channel guide / now-playing data (e.g. `http://192.168.1.100:32400`). Required when `ROOM_TYPE_LIVETV=true`. Falls back to `PLEX_URL` if unset — only needed when your DVR is on a different Plex server. |
| `LIVETV_PLEX_TOKEN` | No | Plex token for the Live TV server. Falls back to `PLEX_TOKEN` if unset. |
| `HDHR_IP` | No | LAN address of your HDHomeRun tuner. When set, Live TV video is pulled directly from it via ffmpeg and Plex is used only for the guide. If unset, Live TV tunes through Plex's DVR instead. |
| `HDHR_PORT` | No | HDHomeRun streaming port (default: `5004`) |
| `LIVETV_SOURCE` | No | `hdhr` (default when `HDHR_IP` is set) or `plex` to force the Plex DVR path |
| `LIVETV_BUFFER_SEC` | No | Live TV playback buffer in seconds (default: `10`, range 4–60). Rooms play this far behind the newest recorded video, so larger values ride out hiccups but add delay and lengthen start-up |
| `LIVETV_X264_PRESET` | No | x264 speed/quality preset for the software encode (default: `veryfast`) |
| `LIVETV_MAX_BITRATE` | No | Peak video bitrate for the encode (default: `8M`) |
| `LIVETV_HWACCEL` | No | `vaapi` to encode on an Intel or AMD iGPU instead of the CPU (Linux hosts; also run with `docker-compose.vaapi.yml` so `/dev/dri` is available in the container). `intel` and `amd` are accepted as aliases. Falls back to software x264 if no GPU is found or it fails. |
| `LIVETV_VAAPI_DEVICE` | No | VAAPI render device. Default: the first Intel or AMD node in `/dev/dri` (an NVIDIA card is skipped). Set it explicitly if the box has several GPUs. |
| `LIVETV_VIDEO_ARGS` | No | Replace the whole video encoder argument list, e.g. `-c:v h264_nvenc -preset p4 -b:v 6M` for hardware encoding |

---

## Deployment notes

- **PLEX_URL must be a LAN address.** If you use your external domain, every video segment will round-trip through your reverse proxy, saturating your upload bandwidth.
- **COOKIE_SECURE must match your protocol.** `true` behind HTTPS, `false` over plain HTTP. Getting this wrong will silently break all sessions.
- Rooms and chat are **in-memory only** — everything is lost on server restart. This is intentional.
- The stream proxy restricts forwarded requests to Plex transcode paths only (`/video/:/transcode/universal/` and `/library/parts/`). Arbitrary Plex API access through the proxy is blocked.
- **Live TV needs an HDHomeRun and a Plex server for the guide.** `ROOM_TYPE_LIVETV=true` does nothing without a Plex server that has a DVR device (e.g. HDHomeRun) configured with channels — Plex provides the channel list and programme info. `LIVETV_PLEX_HOST` and `HDHR_IP` must be LAN addresses reachable from the container.
- **Live TV encodes on the server's CPU.** Each room runs one ffmpeg (software x264 by default — roughly one core for a 1080i channel at the `veryfast` preset) and occupies one tuner. On a Linux host with an Intel or AMD iGPU, set `LIVETV_HWACCEL=vaapi` and start with `docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up --build -d` to move the encode to the GPU (the deinterlace stays on the CPU); other hardware encoders can be used via `LIVETV_VIDEO_ARGS`.
- **Live TV DVR uses disk.** Each room records up to one hour to `DATA_PATH/dvr` (default `/data/dvr`) — roughly 3–4 GB per room-hour at the default bitrate. It is deleted when the room closes and wiped on server start. Size the Docker volume accordingly.
