# Playdarr

> ⚠️ **Vibe coded.** This entire application was built through conversational prompting with Claude (claude-sonnet-4-6) — no traditional development workflow. The code works, but it has not been audited, formally tested, or reviewed by anyone who would describe themselves as sober. Use accordingly.

Playdarr is a self-hosted watch-party app for Plex. It lets you and your friends stream movies from your Plex server in sync, with real-time chat, reactions, and playback controls — all through a browser, no plugins required.

📺 **On the couch?** [Playdarr for Android TV](https://github.com/tf-anguskong/Playdarr-AndroidTV) brings rooms to Google TV / Android TV.

📖 **Running a server?** The **[Admin Guide](wiki/Home.md)** covers setup, the admin panel, Discord webhooks, moderation, recurring watch nights, Live TV, backups and troubleshooting. (The pages are in the [`wiki/`](wiki/) folder and can be published to the GitHub Wiki tab — see [`wiki/README.md`](wiki/README.md).)

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
- **Live TV split view** — the host can put up to **4 channels on screen at once** in one Live TV room (side by side, two-over-one, or a 2×2 grid). Everyone sees the same tiled picture, and **each viewer picks which channel they hear** from the sidebar, by clicking a tile's label, or with keys **1–4** (also in fullscreen); the choice is per viewer and remembered for that room. The host adds, changes (✎) or removes (✕) tiles from the sidebar. The whole picture is a single encode, so it costs about one channel's encoder plus a little decoding per extra channel, but **each tile holds a tuner** and counts against `LIVETV_MAX_ROOMS`. Changing a tile's channel keeps the recording, so the room can still rewind past the change. Needs the HDHomeRun source; every channel must have audio. Turn it off or cap it with `LIVETV_SPLIT_MAX` (also on the Settings page)
- **Picture in Picture** — a PiP button on the player pops the video into a floating window that keeps following the room's play/pause/seek. Viewers who can't control playback (Live TV guests, guests in a locked room) are put straight back in step if they press pause in the PiP window
- **Multi-room** — multiple watch parties can run simultaneously, each with their own state

### Rooms & Access

> **Who can create rooms?** Only users authenticated against your own Plex server can create rooms or schedule sessions. Playdarr verifies at login that the authenticating Plex account actually has access to the configured `PLEX_URL` — if they don't, they can't log in. Guests (people without a Plex account) can only join via an invite link shared by a Plex user; they cannot create rooms, schedule sessions, or access the lobby independently. A guest can be granted host of an existing room via transfer or auto-migration, but that only gives them control over playback — they still cannot open new rooms.

- **Plex login** — sign in via Plex OAuth; only accounts with verified access to your Plex server can log in and create rooms
- **Guest invite links** — hosts share a link; guests enter a display name and join without a Plex account; guests cannot see the lobby or create rooms
- **Host transfer** — the host can promote any viewer (including guests) to host mid-session, giving them playback control for that room; guests granted host cannot create new rooms or scheduled events
- **Auto host migration** — if the host leaves and other viewers remain, the room automatically promotes the next best viewer (preferring Plex users over guests) rather than closing
- **Server-owner admin** — whoever *owns* the Plex server Playdarr is connected to is detected automatically at login (plex.tv marks the account as owner of that server), with no extra config. Admins get an `admin` badge and can close any room, kick any viewer (and block them from rejoining that room) from the lobby or from inside a room, and cancel any scheduled room. Other users, including hosts, can't kick an admin. Sign out and back in after upgrading for the owner flag to be picked up.
- **Room persistence** — rooms live in memory; a 30-second grace timer keeps a room alive if the host briefly navigates away
- **Rich link previews** — paste an invite link into Discord, Slack, iMessage, etc. and it unfurls with what's on (🎬 movie and year, 📺 show and episode, 🔴 Live TV channel and programme, 📅 scheduled night and time), the artwork, play status and progress, the host and how many are watching. Artwork is served through Playdarr, so your Plex token never leaves the server; viewer names are never included

- **Live TV: on now** — when Live TV rooms are enabled, the lobby shows what's airing right now on your channels (logo, channel and current program, main networks first, refreshed every couple of minutes). Click a channel and Playdarr asks whether to start a Live TV room on it; the room tunes the channel as soon as you arrive. A *More channels* card starts an empty Live TV room so you can pick from the full guide.
- **Recently added** — the lobby (Plex users) shows a short strip of the newest movies and TV shows from your Plex libraries. Click a card and Playdarr asks whether to create a room with it ready to go. TV cards are shows that just got new episodes ("2 new" badge) and start at the first of the new episodes — for a brand-new show, S1E1. The room is named after the title.

### Scheduled Rooms

> Scheduling is Plex-only. Guests cannot schedule rooms.

- **Schedule a room** — Plex users can schedule a watch party in advance, picking a date/time, timezone, room name, and optionally pre-selecting a movie
- **Pre-shared invite links** — the invite link is generated at scheduling time and can be shared immediately; it works both before and after the room opens
- **Waiting page** — guests who arrive early see a branded waiting page showing the scheduled date/time in their local timezone; the page polls in the background and redirects automatically when the room opens
- **First-joiner becomes host** — when the scheduled time arrives and the room opens, whoever joins first is granted host, regardless of whether they have a Plex account
- **Persistent schedule** — upcoming scheduled rooms survive server restarts (`DATA_PATH/scheduled.json`); the timer re-arms on startup
- **Default timezone** — set `DEFAULT_TIMEZONE` in `.env` to pre-fill the timezone picker when scheduling (e.g. `America/New_York`)
- **Recurring watch nights** — choose *Every week* or *Every 2 weeks* when scheduling. The night keeps the same local time across daylight-saving changes and the **same invite link every time**, so people can bookmark it. The lobby card has *Skip next* and *Cancel series*; a night missed by more than 6 hours (server down) is skipped rather than opened late.
- **Calendar invites** — every scheduled night has an `.ics` download (Apple, Outlook, …) and an *Add to Google Calendar* link, on the lobby card and on the guest waiting page. Recurring nights carry a repeat rule and a 15-minute alarm. The `.ics` is served from the invite token (`/join/<token>/event.ics`), so anyone with the invite link can add it.

### Movie Vote

Movie rooms have a **🗳 Movie vote** button for the host.

- **Host controls it** — pick genres, rating (G/PG/R…), length, year range, minimum rating and deck size, then start. The server draws a random deck of matching movies from your Plex library.
- **Everyone swipes** — drag a card right (yes) or left (no), tap ♥ / ✕, or use the arrow keys. Guests vote too. A refresh mid-vote restores your swipes.
- **Most likes wins** — the result is revealed automatically when everyone in the room has finished (or the host can reveal early). Ties go to the movie with the fewest *no*s. A unanimous winner is celebrated; the runners-up are listed and the host can play any of them with one click, which loads it into the room.

### Admin Panel & Webhooks

Whoever owns the Plex server is the admin (see *Server-owner admin* above) and gets an **Admin** button in the lobby, opening `/admin`:

- **Webhooks** — post to a Discord channel (or any JSON endpoint, e.g. ntfy, n8n, Home Assistant) when:
  - a watch night is **scheduled**,
  - a watch night is **about to start** — a reminder sent N minutes before (5 min – 1 day, per webhook), once per night, including each occurrence of a recurring one,
  - a scheduled room **opens**, or
  - a room is **created**.

  Every message carries the invite link. Discord gets an embed with localised `<t:…>` timestamps; *Generic JSON* gets `{ event, title, message, url, data }`. Each webhook has a *Send test* button and shows the status of its last delivery. Webhook URLs are secrets: they're stored in `DATA_PATH/webhooks.json` (mode 600) and never sent back to the browser (only a short hint is shown). Create a Discord webhook under *Channel settings → Integrations → Webhooks*.
- **People** — every Plex account that has signed in, with the nickname they chose, whether they're online now, last seen, and sign-in count (searchable). Nicknames are **remembered**: a person's display name is saved against their Plex account (`DATA_PATH/users.json`), so it survives signing out, expired sessions and restarts and comes back automatically at their next sign-in. *Rename* sets someone's nickname and *Reset nickname* clears it (e.g. an inappropriate name); both apply immediately wherever the person is connected, and they can still pick a new one themselves. Only Plex accounts are tracked — guests are throwaway identities per invite — and email addresses are not stored.
- **Settings page** (`/admin/settings`) — change most of the server's configuration from the browser instead of editing `.env`: room types, default time zone, chat & moderation (the offensive-word filter and its word lists, the GIF content rating, and who may post images), the HDHomeRun tuner and Live TV source, how many Live TV channels may stream and whether rooms may split the screen between channels, the playback buffer, upscaling and sharpening, encoder speed and bitrate, and hardware encoding. Each setting has a friendly name and a short description (the raw variable names never appear). Changes apply immediately (one, the channel guide server, needs a restart) and are saved to `DATA_PATH/settings.json`. **Anything defined in your `.env` file takes priority**: it's shown with a 🔒 *Set in .env* tag and can't be changed in the UI, so edit `.env` and recreate the container to change it. A read-only *Server connection* section shows how Playdarr is wired (Plex address, public address, port…) and whether the secrets (Plex token, session secret) are configured, without ever revealing them.
- **Always-on rooms** — pin a room open with nobody in it (owner only). It stays listed in the lobby with a permanent invite link and survives restarts; whoever arrives first (a Plex user, or a guest with the link) becomes host, and when everyone leaves it resets rather than closes (after a 10-second grace for page refreshes). A **Live TV** always-on room can pin one channel or several (it then opens in split view), tunes them **on first join** and stops recording when it empties, so an empty one holds no tuner and no CPU. Movie and TV rooms just stay open and empty.
- **Live rooms** — every open room with who's in it; kick (and block from rejoining) or close.
- **Scheduled & recurring** — everything upcoming, with copy link, skip next, and cancel. `APP_URL` must be set so links in notifications point at your public address.

### Chat
- **Real-time chat** — everyone in the room can chat; each message carries the sender's position in the video and the time it was sent. People who join late (or refresh) see the last 100 messages
- **Modern basics** — replies (click a quote to jump to the original), delete your own messages, multi-line messages (Shift+Enter), clickable links, @mentions with a picker, "… is typing", grouped consecutive messages, and a "↓ new messages" button when you've scrolled up
- **Reactions on messages** — the same six emojis as the video reactions; hover a count to see who reacted
- **GIFs** — search and post GIFs from Giphy (needs a free `GIPHY_API_KEY`; the key stays on the server and the content rating is set by the admin)
- **Images** — paste, drag in or attach your own pictures (PNG, JPEG, WebP, GIF up to 8 MB). The server resizes and re-saves every image (stripping hidden data such as phone location), only people in that room can see it, and it's deleted with its message or when the room closes. The admin chooses who may post them: everyone, Plex users only, or nobody
- **Room to chat** — drag the sidebar's edge to make it wider, switch to *bigger chat* to hide the other panels, or pop chat out into its own window
- **Chat export** — download the chat log as a `.txt` file with video timestamps

### Moderation
- **Rename** — the server owner can rename anyone (for a Plex user that becomes their nickname everywhere); a host can rename guests in their room. Renames show immediately
- **Mute** — the host or owner can stop someone chatting (messages, GIFs, images and reactions) for the rest of the room; they can keep watching. It survives a refresh
- **Delete messages** — the host can remove anyone's message (except the owner's); the owner can remove anyone's
- **Offensive-word filter** — on by default: words are masked in chat (`****`), and guest names, nicknames, room names and renames containing them are refused. It catches look-alike spellings (`sh1t`) without tripping on innocent words (*Scunthorpe*). The admin can turn it off, add words, or allow words it gets wrong
- **Tidy viewer list** — sync offsets, badges and the Host / Rename / Mute / Kick buttons only appear while you hover the list

### Social
- **Play/pause attribution** — a system message appears in chat whenever someone plays or pauses, showing who did it and at what position
- **Emoji reactions** — a reaction bar (👍 ❤️ 😂 😱 😮 👏) overlays the video on hover; reactions float up the screen for all viewers, each tagged with the avatar (or initial) of whoever sent it
- **Sync indicators** — the viewer list shows each viewer's offset from the host (e.g. `+0.3s`), colour-coded green / amber / red, while you hover it
- **Force resync** — the host has a *⟳ Force resync* button under the message box. It pauses everyone at the host's position, shows a 2-second "Resyncing" countdown to everyone, then resumes all viewers together from that same spot. Handy when someone drifts or buffers. It works in every room type (for Live TV it uses the host's own player position), is host-only, and is limited to once every 10 seconds so it can't be spammed.
- **Countdown timer** — host can fire a countdown (3 s, 5 s, 10 s, or custom) before playback begins; all viewers see a film-leader overlay with beep tones; host can cancel mid-count
- **Intermission** — host can start a timed intermission (1–120 minutes); the video pauses for everyone and an overlay displays the movie poster with a live MM:SS countdown; the movie resumes automatically when the timer ends, or the host can end it early

### TV apps
- **Android TV / Google TV** — **[Playdarr for Android TV](https://github.com/tf-anguskong/Playdarr-AndroidTV)** joins an existing Playdarr server from the couch (tested on an NVIDIA Shield). Sign in by entering a code at plex.tv/link on your phone, or join a room with an invite. It covers the lobby, movie / TV / Live TV rooms kept in sync with everyone in the browser, host controls, split-view audio, a people & chat pane and floating reactions. It hosts nothing itself; it needs a server recent enough to have TV sign-in (`/auth/plex/device`)

---

## Stack

- **Backend** — Node.js, Express, Socket.io
- **Frontend** — vanilla JS, no framework
- **Streaming** — Plex HLS transcoding proxied server-side for movies/TV; Live TV via ffmpeg from an HDHomeRun into an on-disk HLS DVR; [HLS.js](https://github.com/video-dev/hls.js) on the client
- **Auth** — Plex PIN-based OAuth for Plex users; session-based guest tokens for invited viewers
- **Sessions** — `express-session` with `session-file-store`
- **Chat extras** — [sharp](https://sharp.pixelplumbing.com/) to re-encode uploaded images, [obscenity](https://github.com/jo3-l/obscenity) for the word filter, the Giphy API for GIFs
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
| `PLEX_CLIENT_ID` | Yes | Unique identifier for this app in Plex sign-in — any stable string (e.g. `my-playdarr`). The server refuses to start without it |
| `DEFAULT_TIMEZONE` | No | IANA timezone used as the default when scheduling rooms (e.g. `America/New_York`). Falls back to `UTC`. |
| `GIPHY_API_KEY` | No | Turns on the GIF button in chat. Create an app at [developers.giphy.com](https://developers.giphy.com/) and choose **API** (not SDK). New keys are rate-limited beta keys (about 100 calls an hour; Playdarr caches results for 10 minutes) — apply for a production key if you need more. Only settable in `.env` |
| `GIPHY_RATING` | No | Most mature GIFs allowed: `g`, `pg`, `pg-13` (default) or `r` |
| `CHAT_UPLOADS` | No | Who may paste/upload images in chat: `all` (default, guests too), `plex` (signed-in Plex users only) or `off` |
| `WORD_FILTER` | No | Offensive-word filter for chat and names (default `true`) |
| `WORD_FILTER_EXTRA` | No | Comma-separated extra words to block |
| `WORD_FILTER_ALLOW` | No | Comma-separated words to always allow (e.g. a place or name the built-in list catches) |
| `PORT` | No | Port to listen on (default: `3000`) |
| `ROOM_TYPE_MOVIE` | No | Set `false` to hide movie rooms from the lobby (default: `true`) |
| `ROOM_TYPE_TV` | No | Set `false` to hide TV show rooms from the lobby (default: `true`) |
| `ROOM_TYPE_YOUTUBE` | No | Set `false` to hide YouTube rooms from the lobby (default: `true`) |
| `ROOM_TYPE_LIVETV` | No | Set `true` to enable Live TV rooms (default: `false`) |
| `LIVETV_PLEX_HOST` | No | LAN address of the Plex server used for the Live TV channel guide / now-playing data (e.g. `http://192.168.1.100:32400`). Required when `ROOM_TYPE_LIVETV=true`. Falls back to `PLEX_URL` if unset — only needed when your DVR is on a different Plex server. |
| `LIVETV_PLEX_TOKEN` | No | Plex token for the Live TV server. Falls back to `PLEX_TOKEN` if unset. |
| `HDHR_IP` | No | LAN address of your HDHomeRun tuner. When set, Live TV video is pulled directly from it via ffmpeg and Plex is used only for the guide. If unset, Live TV tunes through Plex's DVR instead. |
| `HDHR_PORT` | No | HDHomeRun streaming port (default: `5004`) |
| `LIVETV_MAX_ROOMS` | No | Most Live TV **channels** that may be **streaming** at once, across all rooms (default: `2`). A room normally uses one; a split-view room uses one per tile. Each holds a tuner, so keep it at or below your tuner count and what your CPU/GPU can encode. Going over is refused with "Live TV is full right now". Idle rooms (e.g. an empty always-on room) don't count, and the lobby shows "N of M tuners in use". It also caps how many tiles one room can split into. |
| `LIVETV_SPLIT_MAX` | No | Live TV split view: `1` turns it off, `2`–`4` is the most channels one room can show at once (default: `4`, never more than `LIVETV_MAX_ROOMS`). Also on the Settings page, where it applies immediately. |
| `LIVETV_PAUSE_COOLDOWN_SEC` | No | Seconds that must pass between pauses in a Live TV room (default: `10`, `0` turns it off). Rapid play/pause thrashes the recording and can break the stream, so a pause that comes too soon is undone with "You can pause again in Ns". Movie and TV rooms are not limited. |
| `LIVETV_SOURCE` | No | `hdhr` (default when `HDHR_IP` is set) or `plex` to force the Plex DVR path |
| `LIVETV_BUFFER_SEC` | No | Live TV playback buffer in seconds (default: `10`, range 4–60). Rooms play this far behind the newest recorded video, so larger values ride out hiccups but add delay and lengthen start-up |
| `LIVETV_X264_PRESET` | No | x264 speed/quality preset for the software encode (default: `veryfast`) |
| `LIVETV_MAX_BITRATE` | No | Peak video bitrate for the encode (default: `8M`) |
| `LIVETV_HWACCEL` | No | `vaapi` to encode on an Intel or AMD iGPU instead of the CPU (Linux hosts; also run with `docker-compose.vaapi.yml` so `/dev/dri` is available in the container). `intel` and `amd` are accepted as aliases. Falls back to software x264 if no GPU is found or it fails. |
| `LIVETV_VAAPI_DEVICE` | No | VAAPI render device. Default: the first Intel or AMD node in `/dev/dri` (an NVIDIA card is skipped). Set it explicitly if the box has several GPUs. |
| `LIVETV_UPSCALE` | No | `720` or `1080` to upscale channels shorter than that (e.g. 480i SD) with Lanczos scaling. HD channels are left alone. It can't add detail, but looks cleaner than the browser stretching SD. Costs some CPU even with GPU encode, since scaling runs before the encode. |
| `LIVETV_SHARPEN` | No | Sharpen strength applied with `LIVETV_UPSCALE` (default `0.5`, `0` to disable) |
| `LIVETV_VIDEO_ARGS` | No | Replace the whole video encoder argument list, e.g. `-c:v h264_nvenc -preset p4 -b:v 6M` for hardware encoding |

---

## Deployment notes

- **PLEX_URL must be a LAN address.** If you use your external domain, every video segment will round-trip through your reverse proxy, saturating your upload bandwidth.
- **COOKIE_SECURE must match your protocol.** `true` behind HTTPS, `false` over plain HTTP. Getting this wrong will silently break all sessions.
- Rooms and chat are **in-memory only** — everything is lost on server restart. This is intentional.
- **Chat images use disk while a room is open.** Uploaded pictures are stored (re-encoded, max 1600 px) under `DATA_PATH/chat-uploads/<room>/`, deleted when the room closes, and the folder is wiped on every start.
- **GIFs need outbound HTTPS** from the container to `api.giphy.com` (searches) — the images themselves load in viewers' browsers from Giphy's CDN.
- The stream proxy restricts forwarded requests to Plex transcode paths only (`/video/:/transcode/universal/` and `/library/parts/`). Arbitrary Plex API access through the proxy is blocked.
- **Live TV needs an HDHomeRun and a Plex server for the guide.** `ROOM_TYPE_LIVETV=true` does nothing without a Plex server that has a DVR device (e.g. HDHomeRun) configured with channels — Plex provides the channel list and programme info. `LIVETV_PLEX_HOST` and `HDHR_IP` must be LAN addresses reachable from the container.
- **Live TV encodes on the server's CPU.** Each room runs one ffmpeg (software x264 by default — roughly one core for a 1080i channel at the `veryfast` preset) and occupies one tuner. A split-view room still runs a single ffmpeg and a single encode, but holds one tuner per tile and adds the decode/deinterlace of each extra channel. On a Linux host with an Intel or AMD iGPU, set `LIVETV_HWACCEL=vaapi` and start with `docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up --build -d` to move the encode to the GPU (the deinterlace stays on the CPU); other hardware encoders can be used via `LIVETV_VIDEO_ARGS`.
- **GPU encode checklist.** The kernel driver on the Docker host does the work (`i915`/`xe` for Intel, `amdgpu` for AMD); the image already carries the userspace drivers and `vainfo`. Verify with `ls -l /dev/dri` on the host, then after starting with the override, `docker exec playdarr vainfo` (should list H.264 `EncSlice`) and `docker compose logs | grep "enc="` (should say `enc=vaapi`). If the GPU path fails twice with no output, Playdarr logs a warning and drops back to software x264. Tested on an Intel iGPU (iHD driver) in a Proxmox LXC; AMD is wired the same way but untested here.
- **Docker in a Proxmox LXC.** The LXC shares the Proxmox host's kernel, so only the passthrough is needed: in the LXC's Resources add a *Device Passthrough* for `/dev/dri/renderD128` (set the GID to the container's `render` group, usually 104), or add `dev0: /dev/dri/renderD128,gid=104` to `/etc/pve/lxc/<ID>.conf`, and restart it. Docker inside the LXC also needs `nesting=1` (and usually `keyctl=1`). The Playdarr container runs as root, so no `group_add` is needed.
- **Live TV DVR uses disk.** Each room records up to one hour to `DATA_PATH/dvr` (default `/data/dvr`) — roughly 3–4 GB per room-hour at the default bitrate. It is deleted when the room closes and wiped on server start. Size the Docker volume accordingly.
