# Configuration Reference

All settings live in `.env` (copy `.env.example` to start). **After editing `.env`, recreate the container** — a plain restart does not re-read it:

```bash
docker compose up -d --force-recreate
```

> **Prefer a UI?** Most of the settings below can also be changed from **Admin → Settings** ([Settings Page](Settings-Page)). A value defined in `.env` always takes priority and shows as locked there. The Settings page uses friendly names, so [the mapping table](Settings-Page#which-setting-is-which-variable) lists which is which.

## Required

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Random secret that signs session cookies (at least 32 characters; the server refuses to start otherwise). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PLEX_URL` | Plex server address **as seen from the container**, on your LAN (e.g. `http://192.168.1.100:32400`, or `http://host.docker.internal:32400`). Never your public domain — video must stay on the LAN |
| `PLEX_TOKEN` | Plex server token (Plex → Settings → Troubleshooting → *Your Plex Token*) |
| `APP_URL` | Public URL of Playdarr. Builds the Plex sign-in callback **and** the links in Discord messages, calendar files and invite-link preview cards (including their artwork) |
| `COOKIE_SECURE` | `true` behind HTTPS, `false` for plain HTTP/local dev. Set it to match reality or sign-in will loop |
| `PLEX_CLIENT_ID` | A unique, stable identifier for this app in Plex sign-in (any string, e.g. `my-playdarr`). **The server refuses to start without it.** Keep it the same once set |

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `NODE_ENV` | `production` | Standard Node setting |
| `DEFAULT_TIMEZONE` | `UTC` | IANA zone pre-selected when scheduling (e.g. `America/New_York`) |
| `WORD_FILTER` | `true` | Offensive-word filter: masks words in chat, refuses names containing them |
| `WORD_FILTER_EXTRA` | — | Comma-separated extra words to block |
| `WORD_FILTER_ALLOW` | — | Comma-separated words to always allow (false positives) |
| `GIPHY_API_KEY` | — | Turns on GIFs in chat. Create an app at developers.giphy.com and choose **API** (not SDK). A new key is a rate-limited beta key (about 100 calls an hour; Playdarr caches searches for 10 minutes); apply for a production key if that's not enough |
| `GIPHY_RATING` | `pg-13` | Most mature GIFs allowed: `g`, `pg`, `pg-13` or `r` |
| `CHAT_UPLOADS` | `all` | Who may paste/upload images in chat: `all` (guests too), `plex` (signed-in Plex users) or `off` |
| `DATA_PATH` | `/data` | Where Playdarr stores sessions, schedules, webhooks, people and recordings. In Docker this is the `sessions` volume |

## Room types

| Variable | Default | Description |
|---|---|---|
| `ROOM_TYPE_MOVIE` | `true` | Movie rooms |
| `ROOM_TYPE_TV` | `true` | TV show rooms |
| `ROOM_TYPE_YOUTUBE` | `true` | YouTube rooms |
| `ROOM_TYPE_LIVETV` | `false` | Live TV rooms (needs the Live TV settings below) |

Set a type to `false` to hide it from the lobby (and from the *Recently added* strip).

## Live TV

See [Live TV Administration](Live-TV-Administration) for what these mean in practice.

| Variable | Default | Description |
|---|---|---|
| `LIVETV_PLEX_HOST` | `PLEX_URL` | Plex server used for the channel guide. Only needed if the DVR is on a different Plex server |
| `LIVETV_PLEX_TOKEN` | `PLEX_TOKEN` | Token for that server |
| `HDHR_IP` | — | HDHomeRun tuner address. Set = video comes directly from the tuner; unset = tuned through Plex's DVR |
| `HDHR_PORT` | `5004` | HDHomeRun streaming port |
| `LIVETV_SOURCE` | `hdhr` if `HDHR_IP` is set | `hdhr` or `plex` (force the Plex DVR path) |
| `LIVETV_PAUSE_COOLDOWN_SEC` | `10` | Seconds that must pass between pauses in a Live TV room. `0` turns it off. Movie and TV rooms aren't limited |
| `LIVETV_MAX_ROOMS` | `2` | Most Live TV **channels** that may be streaming at once, across all rooms. A room normally uses one; a split-view room uses one per channel on screen. Each holds a tuner, so keep it at or below your tuner count and what your CPU/GPU can encode. It also caps how many channels one room can split into. Whole number, 1 or more; anything else logs a warning and uses 2 |
| `LIVETV_SPLIT_MAX` | `4` | [Split view](Live-TV-Administration#split-view-several-channels-in-one-room): `1` turns it off, `2`–`4` is the most channels one room can show at once (never more than `LIVETV_MAX_ROOMS`). Also on the Settings page |
| `LIVETV_BUFFER_SEC` | `10` | Seconds behind live a room plays (range 4–60) |
| `LIVETV_UPSCALE` | off | `720` or `1080`: upscale shorter channels to this height |
| `LIVETV_SHARPEN` | `0.5` | Sharpen strength used with upscaling (`0` = off) |
| `LIVETV_X264_PRESET` | `veryfast` | Software encode speed/quality |
| `LIVETV_MAX_BITRATE` | `8M` | Peak video bitrate |
| `LIVETV_HWACCEL` | off | `vaapi` (aliases `intel`, `amd`) for iGPU encoding; needs `docker-compose.vaapi.yml` |
| `LIVETV_VAAPI_DEVICE` | first Intel/AMD node | Render device, e.g. `/dev/dri/renderD128`, when there are several GPUs |
| `LIVETV_VAAPI_BITRATE` | `6M` | Target bitrate for the GPU encode |
| `LIVETV_VIDEO_ARGS` | — | Replace the whole video encoder argument list (e.g. NVENC). Overrides the encoder settings above. Only video-encoder options are accepted (`-c:v`, `-preset`, `-tune`, `-profile:v`, `-level`, `-b:v`, `-maxrate`, `-bufsize`, `-crf`, `-cq`, `-qp`, `-rc`, `-g`, `-bf`, `-pix_fmt` and similar), each followed by one value; anything else (extra outputs, `-f`, `-i`, filters, file paths) is refused, and a value that fails the check is ignored with a warning in the log and the default encoder is used |

## Not configured here

These are managed in the app, not `.env`:

- **Webhooks and reminders:** Admin → Webhooks (stored in `webhooks.json`).
- **Who is an admin:** automatic from Plex ownership.
- **Nicknames:** set by each person; renamed or reset by you in Admin → People (hosts can rename guests in their room).
- **Schedules:** the lobby's *Schedule* button.
